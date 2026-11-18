// A diff review's comments and replies. Comments reach the agent one of two
// ways:
//
//   session   each delivery is one message to a Claude Code session's inbox
//             socket, as prose's markdown reviews do, and the agent answers
//             with prose respond
//   task      each comment becomes a review todo in a fleet task's note,
//             through `fleet comment`, and a review ends with `fleet bump`.
//             The worker checks the todo and may add `- reply:` lines under
//             it, which the page shows as the thread's replies.
//
// Either way the server keeps every comment in its activity log, so the
// page can draw the threads after a restart.

import { basename, dirname } from "@std/path"
import { ActivityLog, type ActivityInput, type Event, InputError, type UserInput } from "./events.ts"
import { postToSession, type Session, sessionAlive } from "./session.ts"

export type Sink =
  | { kind: "session" }
  | { kind: "task"; fleet: string; task: string; note: string }

// What the note says about one comment's todo
export type NoteThread = { checked: boolean; replies: string[] } | { missing: true }

export type ReviewCtx = { session: Session | null; port: number; dir: string; label: string }

async function fleet(args: string[]) {
  const out = await new Deno.Command("fleet", { args, stdout: "piped", stderr: "piped" }).output()
  const text = (b: Uint8Array) => new TextDecoder().decode(b).trim()
  if (!out.success) throw new InputError(text(out.stderr) || `fleet ${args[2]} exited ${out.code}`, 502)
  return text(out.stdout)
}

// The todo a comment became, its checkbox, and the indented `- reply:` lines
// under it. A todo the worker reworded or removed is missing.
export function noteThreads(text: string, events: Event[]): Record<string, NoteThread> {
  const lines = text.split("\n")
  const out: Record<string, NoteThread> = {}
  for (const event of events) {
    if (event.kind !== "diff-comment" || !event.todo) continue
    const body = event.todo.replace(/^- \[[ x]\] /, "")
    const at = lines.findIndex((line) => /^- \[[ xX]\] /.test(line) && line.slice(6) === body)
    if (at < 0) {
      out[event.id] = { missing: true }
      continue
    }
    const replies: string[] = []
    for (const line of lines.slice(at + 1)) {
      if (!/^\s/.test(line)) break
      const reply = /^\s+- reply:\s*(.*)$/.exec(line)
      if (reply) replies.push(reply[1])
    }
    out[event.id] = { checked: lines[at][3] !== " ", replies }
  }
  return out
}

export class DiffReview {
  readonly clients = new Set<WebSocket>()
  #mutations: Promise<unknown> = Promise.resolve()
  #note: Record<string, NoteThread> = {}

  constructor(
    readonly key: string,
    readonly activity: ActivityLog,
    readonly sink: Sink,
    private readonly ctx: ReviewCtx,
  ) {
    if (sink.kind === "task") {
      this.#readNote()
      this.#watchNote(sink.note)
    } else {
      // held requests retry while the session is up, as prose's DocSet does
      setInterval(() => {
        if (sessionAlive(this.ctx.session)) this.flushHeld().catch(() => {})
      }, 10_000)
    }
  }

  get session() {
    return this.ctx.session
  }

  snapshot(replay: boolean) {
    const connected = this.sink.kind === "task" || sessionAlive(this.ctx.session)
    return JSON.stringify({
      ...this.activity.snapshot(connected),
      replay,
      sink: this.sink.kind === "task" ? { kind: "task", task: this.sink.task, fleet: this.sink.fleet } : { kind: "session" },
      note: this.#note,
    })
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
    ws.send(this.snapshot(true))
  }

  #mutate<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#mutations.then(fn)
    this.#mutations = next.catch(() => {})
    return next
  }

  #readNote() {
    if (this.sink.kind !== "task") return
    try {
      this.#note = noteThreads(Deno.readTextFileSync(this.sink.note), this.activity.events)
    } catch {
      // archived or mid-save; the next change catches up
    }
  }

  // the note's folder, since a save by rename-replace would leave a watch on
  // the file itself stale
  #watchNote(note: string) {
    ;(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      for await (const event of Deno.watchFs(dirname(note))) {
        if (!event.paths.some((p) => basename(p) === basename(note))) continue
        clearTimeout(timer)
        timer = setTimeout(() => {
          this.#readNote()
          this.#send(this.snapshot(false))
        }, 100)
      }
    })()
  }

  async #deliver(events: string[]) {
    const { session, port, dir, label } = this.ctx
    if (!session) return false
    try {
      await postToSession(session, [
        `Prose diff review of ${dir} (${label}; port ${port}; handle per /prose skill; reply with prose respond ${port} <phase> <request ids>):`,
        ...events,
      ].join("\n"))
      return true
    } catch (error) {
      console.error(`prose: could not reach session at ${session.socket}:`, error)
      return false
    }
  }

  // One or more comments, sent together: one message to the session, or
  // todos in the task's note and one bump. A message (the conversation
  // panel's general text) goes to a session only.
  review(inputs: UserInput[]) {
    return this.#mutate(async () => {
      if (inputs.length === 0) throw new InputError("Nothing to send")
      return this.sink.kind === "task" ? await this.#toNote(inputs) : await this.#toSession(inputs)
    })
  }

  async #toSession(inputs: UserInput[]) {
    const held = this.activity.held()
    const events: Event[] = []
    for (const input of inputs) events.push(await this.activity.append(input))
    const delivered = await this.#deliver([...held, ...events].map((e) => JSON.stringify(e)))
    if (delivered) await this.activity.markDelivery("delivered", held.map((e) => e.id))
    else await this.activity.markDelivery("held", events.map((e) => e.id))
    this.#send(this.snapshot(false))
    return { events, delivered, warning: "" }
  }

  async #toNote(inputs: UserInput[]) {
    if (this.sink.kind !== "task") throw new Error("not a task review")
    const { fleet: name, task } = this.sink
    if (inputs.some((input) => input.kind !== "diff-comment")) {
      throw new InputError(`A task review takes line comments only; they go to ${task}'s note`)
    }
    const events: Event[] = []
    let warning = ""
    // each comment is written as it goes, so a failure partway keeps the
    // ones before it, and the page drops only their drafts
    for (const input of inputs) {
      const a = input.anchor!
      const at = `${a.path}:${a.line}${a.end > a.line ? `-${a.end}` : ""}`
      const args = ["-s", name, "comment", task, at]
      // an old-side line is in the base commit, which the worker reads with git show
      if (a.side === "old" && a.rev) args.push("--at", a.rev)
      if (a.quote.trim()) args.push("--quote", a.quote)
      try {
        const todo = await fleet([...args, "--", (input.text ?? "").replace(/\s*\n\s*/g, " ")])
        events.push(await this.activity.append({ ...input, todo }))
      } catch (error) {
        if (events.length === 0) throw error
        warning = `Saved ${events.length} of ${inputs.length} comments to ${task}'s note; the rest stay as drafts: ${
          error instanceof Error ? error.message : error
        }`
        break
      }
    }
    try {
      await fleet(["-s", name, "bump", task])
    } catch (error) {
      warning ||= `Saved to ${task}'s note, but fleet bump failed: ${error instanceof Error ? error.message : error}`
    }
    this.#readNote()
    this.#send(this.snapshot(false))
    return { events, delivered: !warning, warning }
  }

  flushHeld() {
    return this.#mutate(async () => {
      const held = this.activity.held()
      if (held.length === 0 || !(await this.#deliver(held.map((e) => JSON.stringify(e))))) return 0
      await this.activity.markDelivery("delivered", held.map((e) => e.id))
      this.#send(this.snapshot(false))
      return held.length
    })
  }

  // prose join: another session takes the review and gets what was held
  join(session: Session) {
    this.ctx.session = session
    return this.flushHeld()
  }

  postActivity(input: ActivityInput) {
    return this.#mutate(async () => {
      const event = await this.activity.append(input)
      this.#send(this.snapshot(false))
      return { event, delivered: false }
    })
  }
}
