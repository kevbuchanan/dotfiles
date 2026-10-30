// The markdown files one server reviews. The server starts with one file and
// opens others when the page follows a link to them, so each file has its
// own state here: text on disk, an edit-notice window, the page sockets
// subscribed to it, its comment log, and a queue that keeps its file
// context, log and session delivery in order. Every file's events go to the
// same session, each headed with that file's path.

import { basename, dirname, join } from "@std/path"
import { ActivityLog, type ActivityInput, type UserInput } from "./events.ts"
import { formatForSession, postToSession, type Session, sessionAlive } from "./session.ts"

// Single contiguous splice turning oldStr into newStr (common prefix/suffix
// diff), for describing a disk change to the session compactly.
export function splice(oldStr: string, newStr: string) {
  let start = 0
  const maxStart = Math.min(oldStr.length, newStr.length)
  while (start < maxStart && oldStr[start] === newStr[start]) start++
  let endOld = oldStr.length
  let endNew = newStr.length
  while (endOld > start && endNew > start && oldStr[endOld - 1] === newStr[endNew - 1]) {
    endOld--
    endNew--
  }
  return { start, delLen: endOld - start, insert: newStr.slice(start, endNew) }
}

export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path)

export class Doc {
  readonly clients = new Set<WebSocket>()
  #content: string
  #windowBase: string | null = null
  #mutations: Promise<unknown> = Promise.resolve()

  private constructor(
    readonly file: string,
    readonly activity: ActivityLog,
    content: string,
    readonly commentLog: string,
    private readonly ctx: { session: Session | null; port: number },
  ) {
    this.#content = content
  }

  static async open(file: string, stateDir: string, ctx: { session: Session | null; port: number }) {
    // One log per file under XDG state, named by its absolute path with
    // slashes flattened, so drafts in versioned directories stay clean.
    const commentLog = join(stateDir, file.replaceAll("/", "-") + ".comments.jsonl")
    const doc = new Doc(
      file,
      await ActivityLog.open(commentLog, file),
      await Deno.readTextFile(file),
      commentLog,
      ctx,
    )
    doc.#watch()
    return doc
  }

  docMessage() {
    return JSON.stringify({ type: "doc", file: this.file, text: this.#content })
  }

  snapshot(replay: boolean) {
    return JSON.stringify({ ...this.activity.snapshot(sessionAlive(this.ctx.session)), replay })
  }

  #send(message: string) {
    for (const ws of this.clients) {
      try {
        ws.send(message)
      } catch {
        this.clients.delete(ws)
      }
    }
  }

  addClient(ws: WebSocket) {
    this.clients.add(ws)
    ws.send(this.docMessage())
    ws.send(this.snapshot(true))
  }

  #mutate<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#mutations.then(fn)
    this.#mutations = next.catch(() => {})
    return next
  }

  // --- disk -> preview ---

  async onDiskChange() {
    let disk: string
    try {
      disk = await Deno.readTextFile(this.file)
    } catch {
      return // transiently missing (rename-replace save); next event catches up
    }
    if (disk === this.#content) return
    this.#windowBase ??= this.#content
    this.#content = disk
    this.#send(this.docMessage())
  }

  // Watch the parent dir rather than the file: most editors save by
  // rename-replace, which makes a watch on the file itself go stale.
  #watch() {
    const target = basename(this.file)
    ;(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      for await (const event of Deno.watchFs(dirname(this.file))) {
        if (!event.paths.some((p) => basename(p) === target)) continue
        clearTimeout(timer)
        timer = setTimeout(() => this.onDiskChange(), 80)
      }
    })()
  }

  // --- edit notices to the Claude session ---

  // Edit notices keep the session's model of the file current without a
  // re-read, but the session only needs them when it's about to act, so they
  // never wake it on their own. Disk changes (helix saves, and Claude's own
  // edits echoed back, which the session filters by recognizing its own
  // text) accumulate in a window that flushes right before the next comment,
  // as one splice from the window's base, in the same message as the comment.
  #flushFileEdit(): string | null {
    if (this.#windowBase === null) return null
    const base = this.#windowBase
    this.#windowBase = null
    // A window that nets out to nothing (typed then undone) isn't worth the
    // session's attention.
    if (base === this.#content) return null
    const { start, delLen, insert } = splice(base, this.#content)
    return JSON.stringify({
      kind: "file-edit",
      file: this.file,
      ts: new Date().toISOString(),
      old: base.slice(start, start + delLen).slice(0, 2000),
      new: insert.slice(0, 2000),
    })
  }

  // One socket connection per delivery; a failure leaves the event in the
  // log for the skill's catch-up step, so it never fails the user's POST.
  async #deliver(events: string[]) {
    const { session, port } = this.ctx
    if (!session) return false
    try {
      await postToSession(session, formatForSession(this.file, port, events))
      return true
    } catch (error) {
      console.error(`prose: could not reach session at ${session.socket}:`, error)
      return false
    }
  }

  // A comment goes out with any held requests ahead of it, oldest first, and
  // the edit notice on the line before the comment it's context for. One the
  // session doesn't take is marked held and goes out with the next delivery.
  comment(input: UserInput) {
    return this.#mutate(async () => {
      await this.onDiskChange()
      const fileEdit = this.#flushFileEdit()
      const held = this.activity.held()
      const event = await this.activity.append(input)
      const delivered = await this.#deliver(
        [...held.map((e) => JSON.stringify(e)), fileEdit, JSON.stringify(event)]
          .filter((line) => line !== null),
      )
      if (delivered) await this.activity.markDelivery("delivered", held.map((e) => e.id))
      else await this.activity.markDelivery("held", [event.id])
      this.#send(this.snapshot(false))
      return { event, delivered }
    })
  }

  // Sends held requests on their own, for when the session is back or a new
  // one joined. Returns how many went out.
  flushHeld() {
    return this.#mutate(async () => {
      const held = this.activity.held()
      if (held.length === 0 || !(await this.#deliver(held.map((e) => JSON.stringify(e))))) return 0
      await this.activity.markDelivery("delivered", held.map((e) => e.id))
      this.#send(this.snapshot(false))
      return held.length
    })
  }

  postActivity(input: ActivityInput) {
    return this.#mutate(async () => {
      const event = await this.activity.append(input)
      this.#send(this.snapshot(false))
      return { event, delivered: false }
    })
  }
}

// The files a server has open, keyed by real path. The first is the file the
// server started with, which requests without a file default to.
export class DocSet {
  readonly #docs = new Map<string, Promise<Doc>>()
  #primary = ""

  constructor(
    private readonly stateDir: string,
    private readonly ctx: { session: Session | null; port: number },
  ) {
    // Held requests retry while the session is up, so a delivery that failed
    // once (a slow socket, a session busy restarting) doesn't wait for the
    // next comment.
    setInterval(() => {
      if (sessionAlive(this.ctx.session)) this.flushAll().catch(() => {})
    }, 10_000)
  }

  async flushAll() {
    let sent = 0
    for (const doc of await this.all()) sent += await doc.flushHeld()
    return sent
  }

  // Points every doc at another session, such as one joining with prose join
  // after the first ended, and sends it the held requests.
  async join(session: Session) {
    this.ctx.session = session
    return this.flushAll()
  }

  get primary() {
    return this.#primary
  }

  async start(file: string) {
    const doc = await this.get(file)
    this.#primary = doc.file
    return doc
  }

  // Opens a doc on first use. Only markdown files under $HOME or beside the
  // primary file, the same rule /local applies, can be opened.
  async get(file: string): Promise<Doc> {
    const real = await Deno.realPath(file)
    if (!isMarkdown(real)) throw new Error(`not a markdown file: ${file}`)
    if (this.#primary && !allowed(real, this.#primary)) throw new Error(`not allowed: ${file}`)
    let doc = this.#docs.get(real)
    if (!doc) {
      doc = Doc.open(real, this.stateDir, this.ctx)
      this.#docs.set(real, doc)
      doc.catch(() => this.#docs.delete(real))
    }
    return doc
  }

  // The file a request names with ?file=, or the primary one.
  forRequest(searchParams: URLSearchParams) {
    return this.get(searchParams.get("file") || this.#primary)
  }

  async all(): Promise<Doc[]> {
    return Promise.all(this.#docs.values())
  }

  // The doc whose log holds one of these request ids, so an agent's reply
  // finds its file without naming it.
  async owning(requestIds: string[]): Promise<Doc | undefined> {
    for (const doc of await this.all()) {
      if (requestIds.some((id) => doc.activity.requests.has(id))) return doc
    }
    return undefined
  }
}

// What a server may open or serve: paths under $HOME or beside the primary
// file, and not inside a dot folder, such as .ssh or .config, that the
// primary file's own path doesn't already pass through. A server started on
// a doc in .claude/worktrees/<name>/ can follow links within that worktree.
export const allowed = (real: string, primary: string) => {
  if (![Deno.env.get("HOME")!, dirname(primary)].some((dir) => real.startsWith(dir + "/"))) {
    return false
  }
  const a = real.split("/")
  const b = dirname(primary).split("/")
  let shared = 0
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++
  return !a.slice(shared, -1).some((part) => part.startsWith("."))
}
