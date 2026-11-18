/// <reference lib="dom" />

// Browser half of prose's diff review: bundled at server startup (see
// prose-diff.ts) and served as /bundle.js. Renders the diff the server
// reads with @pierre/diffs, one FileDiff per file, unified. A reviewer
// clicks a line's gutter button, or drags across line numbers and then
// clicks it, to write a comment. Comments wait as drafts in this browser
// until Send review sends them together; Send now sends one alone. Sent
// comments come back from the server as threads at their lines, with the
// agent's replies.
//
// The page polls for a new diff and offers a refresh rather than
// re-rendering on its own, so a line never moves while the reviewer reads
// or writes.

import { type DiffLineAnnotation, FileDiff, type FileDiffMetadata, parsePatchFiles, type SelectedLineRange } from "@pierre/diffs"
import { FileTree, type GitStatusEntry } from "@pierre/trees"
import MarkdownExit from "markdown-exit"
import { Conversation } from "./lib/prose/conversation.ts"
import type { Event, FeedSnapshot, RequestState, UserInput } from "./lib/prose/events.ts"
import { type Anchor, anchorLabel, locate, parsePatch, type PatchFile } from "./lib/prose/patch.ts"
import type { NoteThread } from "./lib/prose/review.ts"

type DiffRead = { key: string; patch: string; hash: string; dir: string; label: string; base: string; head: string }
type Snapshot = FeedSnapshot & {
  sink: { kind: "session" } | { kind: "task"; task: string; fleet: string }
  note: Record<string, NoteThread>
}
type Draft = { id: string; anchor: Anchor; text: string; replyTo?: string }
type Compose = { anchor: Anchor; replyTo?: string; draftId?: string; text: string }
type Meta = { id: string }

const token = document.querySelector<HTMLMetaElement>('meta[name="prose-token"]')!.content
const $ = (id: string) => document.getElementById(id)!
const toast = $("toast")
// the sticky sidebar and scroll targets sit below the bar, which wraps on a
// narrow window
new ResizeObserver(([e]) => {
  document.documentElement.style.setProperty("--bar-height", `${e.target.getBoundingClientRect().height}px`)
}).observe($("bar"))
const markdown = new MarkdownExit({ html: false, linkify: true, breaks: true })
markdown.disable("image")

let diff: DiffRead | null = null
let files: PatchFile[] = []
let snapshot: Snapshot | null = null
let drafts: Draft[] = []
let compose: Compose | null = null
let conversation: Conversation | null = null

// ---------- storage: drafts and viewed files, per review ----------

const store = {
  get<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(localStorage.getItem(`prose-diff:${diff?.key}:${name}`) ?? "null") ?? fallback
    } catch {
      return fallback
    }
  },
  set(name: string, value: unknown) {
    try {
      localStorage.setItem(`prose-diff:${diff?.key}:${name}`, JSON.stringify(value))
    } catch {
      // storage unavailable; drafts and viewed marks last for this page load
    }
  },
}
const saveDrafts = () => store.set("drafts", drafts)

// A file stays viewed until its part of the diff changes
function fileHash(f: PatchFile) {
  let h = 0x811c9dc5
  for (let i = 0; i < f.text.length; i++) h = Math.imul(h ^ f.text.charCodeAt(i), 0x01000193)
  return `${f.path}\0${(h >>> 0).toString(16)}`
}
let viewed = new Set<string>()
const isViewed = (f: PatchFile) => viewed.has(fileHash(f))

function showToast(message: string, ms = 2000) {
  toast.textContent = message
  toast.style.opacity = "1"
  setTimeout(() => (toast.style.opacity = "0"), ms)
}

// ---------- threads ----------

// a reviewer's line comment as the server logged it
type Comment = Extract<Event, UserInput> & { anchor: Anchor }

type Thread = {
  root: Comment
  // the root and the reviewer's replies, in order
  asks: Comment[]
  // agent replies from prose respond, or the worker's `- reply:` lines
  replies: { text: string; seq: number }[]
  status: string
  at: { line: number; end: number } | null
}

const requestOf = (id: string): RequestState | undefined => snapshot?.requests.find((r) => r.id === id)

function threads(): Thread[] {
  if (!snapshot) return []
  const events = snapshot.events
  const comments = events.filter((e): e is Comment => e.kind === "diff-comment" && "anchor" in e && !!e.anchor)
  const rootOf = new Map<string, string>()
  for (const e of comments) rootOf.set(e.id, e.replyTo && rootOf.has(e.replyTo) ? rootOf.get(e.replyTo)! : e.id)
  const out = new Map<string, Thread>()
  for (const e of comments) {
    const root = rootOf.get(e.id)!
    if (root === e.id) out.set(e.id, { root: e, asks: [e], replies: [], status: "", at: locate(files, e.anchor) })
    else out.get(root)?.asks.push(e)
  }
  for (const e of events) {
    if (e.kind !== "activity" || !e.text) continue
    const t = e.requestIds.map((id) => out.get(rootOf.get(id) ?? "")).find(Boolean)
    t?.replies.push({ text: e.text, seq: e.seq })
  }
  for (const t of out.values()) {
    const last = t.asks.at(-1)!
    if (snapshot.sink.kind === "task") {
      const notes = t.asks.map((a) => snapshot!.note[a.id]).filter(Boolean)
      for (const n of notes) if (!("missing" in n)) t.replies.push(...n.replies.map((text) => ({ text, seq: Infinity })))
      const lastNote = snapshot.note[last.id]
      t.status = !lastNote ? "sent" : "missing" in lastNote ? "not in the note" : lastNote.checked ? "done" : "open"
    } else {
      const state = requestOf(last.id)
      t.status = !state ? "" : state.held ? "not delivered" : state.status.replace("-", " ")
    }
  }
  return [...out.values()]
}

// ---------- annotation elements ----------

// One element per thread, draft and the compose form, kept across renders:
// FileDiff re-creates its wrapper when an annotation moves, and moves this
// element into it.
const elements = new Map<string, HTMLElement>()
function element(id: string) {
  let el = elements.get(id)
  if (!el) {
    el = document.createElement("div")
    el.className = "note-card"
    elements.set(id, el)
  }
  return el
}

function button(label: string, onClick: () => void, cls = "") {
  const b = document.createElement("button")
  b.type = "button"
  b.textContent = label
  if (cls) b.className = cls
  b.addEventListener("click", onClick)
  return b
}

function fillThread(el: HTMLElement, t: Thread) {
  el.className = `note-card thread status-${t.status.replace(/ /g, "-")}`
  el.replaceChildren()
  const head = document.createElement("div")
  head.className = "card-head"
  head.textContent = anchorLabel(t.root.anchor)
  if (t.status) {
    const chip = document.createElement("span")
    chip.className = "chip"
    chip.textContent = t.status
    head.append(chip)
  }
  el.append(head)
  const entries = [
    ...t.asks.map((a) => ({ who: "You", text: a.text ?? "", seq: a.seq })),
    ...t.replies.map((r) => ({ who: snapshot?.sink.kind === "task" ? "Worker" : "Agent", text: r.text, seq: r.seq })),
  ].sort((a, b) => a.seq - b.seq)
  for (const entry of entries) {
    const row = document.createElement("div")
    row.className = `card-entry from-${entry.who.toLowerCase()}`
    const who = document.createElement("div")
    who.className = "card-who"
    who.textContent = entry.who
    const body = document.createElement("div")
    body.className = "card-body"
    body.innerHTML = markdown.render(entry.text)
    for (const a of body.querySelectorAll("a")) {
      a.target = "_blank"
      a.rel = "noopener noreferrer"
    }
    row.append(who, body)
    el.append(row)
  }
  const actions = document.createElement("div")
  actions.className = "card-actions"
  actions.append(button("Reply", () => openCompose({ ...t.root.anchor, ...(t.at ?? {}) }, t.root.id)))
  el.append(actions)
}

function fillDraft(el: HTMLElement, d: Draft) {
  el.className = "note-card draft"
  el.replaceChildren()
  const head = document.createElement("div")
  head.className = "card-head"
  head.textContent = anchorLabel(d.anchor)
  const chip = document.createElement("span")
  chip.className = "chip"
  chip.textContent = d.replyTo ? "pending reply" : "pending"
  head.append(chip)
  const body = document.createElement("div")
  body.className = "card-body"
  body.innerHTML = markdown.render(d.text)
  const actions = document.createElement("div")
  actions.className = "card-actions"
  actions.append(
    button("Edit", () => openCompose(d.anchor, d.replyTo, d)),
    button("Delete", () => {
      drafts = drafts.filter((x) => x.id !== d.id)
      saveDrafts()
      renderAll()
    }),
  )
  el.append(head, body, actions)
}

function fillCompose(el: HTMLElement, c: Compose) {
  el.className = "note-card compose"
  if (el.querySelector("textarea")) return // keep what the reviewer is typing
  const head = document.createElement("div")
  head.className = "card-head"
  head.textContent = `${c.replyTo ? "Reply on" : "Comment on"} ${anchorLabel(c.anchor)}`
  const area = document.createElement("textarea")
  area.placeholder = snapshot?.sink.kind === "task" ? "Review comment for the worker" : "Comment for Claude"
  area.value = c.text
  area.addEventListener("input", () => (c.text = area.value))
  const actions = document.createElement("div")
  actions.className = "card-actions"
  const hint = document.createElement("span")
  hint.className = "hint"
  hint.textContent = "⌘⏎ adds to the review · esc cancels"
  actions.append(
    hint,
    button("Cancel", closeCompose),
    button("Send now", () => void sendNow()),
    button(c.draftId ? "Update" : "Add to review", addDraft, "primary"),
  )
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      addDraft()
    }
    if (e.key === "Escape") closeCompose()
  })
  el.replaceChildren(head, area, actions)
  requestAnimationFrame(() => area.focus())
}

function openCompose(anchor: Anchor, replyTo?: string, draft?: Draft) {
  compose = { anchor, replyTo, draftId: draft?.id, text: draft?.text ?? "" }
  elements.get("compose")?.replaceChildren()
  renderAll()
}
function closeCompose() {
  compose = null
  elements.get("compose")?.replaceChildren()
  renderAll()
}
function addDraft() {
  if (!compose || !compose.text.trim()) return
  const c = compose
  if (c.draftId) {
    drafts = drafts.map((d) => d.id === c.draftId ? { ...d, text: c.text.trim() } : d)
  } else {
    drafts.push({ id: crypto.randomUUID(), anchor: c.anchor, text: c.text.trim(), replyTo: c.replyTo })
  }
  saveDrafts()
  closeCompose()
}

// ---------- sending ----------

async function post(comments: { anchor: Anchor; text: string; replyTo?: string }[]) {
  const response = await fetch("/review", {
    method: "POST",
    headers: { "content-type": "application/json", "x-prose-token": token },
    body: JSON.stringify({ comments: comments.map((c) => ({ kind: "diff-comment", ...c })) }),
  })
  if (!response.ok) throw new Error(await response.text())
  return await response.json() as Sent
}

type Sent = { agentConnected: boolean; warning: string; saved: number }

function sentMessage(result: Sent, n: number) {
  if (result.warning) return result.warning
  const what = n === 1 ? "Comment" : `${n} comments`
  if (snapshot?.sink.kind === "task") return `${what} added to ${snapshot.sink.task}'s note; the worker was told`
  return result.agentConnected ? `${what} sent` : `${what} saved · no agent connected`
}

async function sendNow() {
  if (!compose || !compose.text.trim()) return
  const c = compose
  try {
    const result = await post([{ anchor: c.anchor, text: c.text.trim(), replyTo: c.replyTo }])
    if (c.draftId) {
      drafts = drafts.filter((d) => d.id !== c.draftId)
      saveDrafts()
    }
    closeCompose()
    showToast(sentMessage(result, 1), result.warning ? 6000 : 2000)
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 6000)
  }
}

const sendButton = $("send-review") as HTMLButtonElement
sendButton.addEventListener("click", async () => {
  if (!drafts.length) return
  sendButton.disabled = true
  // a copy: a draft added while this posts is not part of it
  const batch = [...drafts]
  try {
    const result = await post(batch.map(({ anchor, text, replyTo }) => ({ anchor, text, replyTo })))
    const sent = new Set(batch.slice(0, result.saved).map((d) => d.id))
    drafts = drafts.filter((d) => !sent.has(d.id))
    saveDrafts()
    renderAll()
    showToast(sentMessage(result, result.saved), result.warning ? 6000 : 2000)
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 6000)
  } finally {
    updateBar()
  }
})

// ---------- rendering ----------

type View = { file: PatchFile; meta: FileDiffMetadata; section: HTMLElement; outdated: HTMLElement; diff: FileDiff<Meta>; keys: string }
let views: View[] = []

const sideOf = (range: SelectedLineRange) => (range.endSide ?? range.side) === "deletions" ? "old" : "new"

function anchorFor(file: PatchFile, range: SelectedLineRange): Anchor {
  const side = sideOf(range)
  const sameSide = (range.side ?? range.endSide) === (range.endSide ?? range.side)
  const [line, end] = sameSide ? [Math.min(range.start, range.end), Math.max(range.start, range.end)] : [range.end, range.end]
  return { path: file.path, side, line, end, quote: file[side].get(line) ?? "", rev: side === "old" ? diff!.base : diff!.head }
}

function viewedToggle(file: PatchFile) {
  const label = document.createElement("label")
  label.className = "viewed"
  const box = document.createElement("input")
  box.type = "checkbox"
  box.checked = isViewed(file)
  box.addEventListener("change", () => {
    if (box.checked) viewed.add(fileHash(file))
    else viewed.delete(fileHash(file))
    store.set("viewed", [...viewed])
    renderAll()
  })
  label.append(box, " Viewed")
  return label
}

function annotationsFor(file: PatchFile, ts: Thread[]): DiffLineAnnotation<Meta>[] {
  const out: DiffLineAnnotation<Meta>[] = []
  const at = (a: { side: "old" | "new"; end: number }, id: string) =>
    out.push({ side: a.side === "new" ? "additions" : "deletions", lineNumber: a.end, metadata: { id } })
  for (const t of ts) if (t.root.anchor.path === file.path && t.at) at({ side: t.root.anchor.side, end: t.at.end }, t.root.id)
  for (const d of drafts) {
    if (d.anchor.path !== file.path) continue
    const where = locate(files, d.anchor)
    if (where) at({ side: d.anchor.side, end: where.end }, `draft:${d.id}`)
  }
  if (compose?.anchor.path === file.path) at(compose.anchor, "compose")
  return out
}

function fillAnnotations(ts: Thread[]) {
  const byId = new Map(ts.map((t) => [t.root.id, t]))
  for (const [id, el] of elements) {
    if (id === "compose") {
      if (compose) fillCompose(el, compose)
    } else if (id.startsWith("draft:")) {
      const d = drafts.find((x) => `draft:${x.id}` === id)
      if (d) fillDraft(el, d)
    } else if (byId.has(id)) {
      fillThread(el, byId.get(id)!)
    }
  }
}

// Threads whose lines are gone, above their file's diff, or above every
// file when the whole file left the diff
function renderOutdated(ts: Thread[]) {
  const lost = ts.filter((t) => !t.at)
  for (const v of views) {
    const mine = lost.filter((t) => t.root.anchor.path === v.file.path)
    v.outdated.hidden = mine.length === 0
    v.outdated.replaceChildren(...(mine.length ? [heading(`Outdated: ${mine.length === 1 ? "this comment's line has" : "these comments' lines have"} changed`)] : []), ...mine.map((t) => cardFor(t)))
  }
  const shown = new Set(views.map((v) => v.file.path))
  const orphans = lost.filter((t) => !shown.has(t.root.anchor.path))
  const box = $("orphans")
  box.hidden = orphans.length === 0
  box.replaceChildren(...(orphans.length ? [heading("Comments on files no longer in the diff")] : []), ...orphans.map((t) => cardFor(t)))
  // a reply to an outdated thread is written under it
  if (compose && !locate(files, compose.anchor)) {
    const el = element("compose")
    fillCompose(el, compose)
    const v = views.find((x) => x.file.path === compose!.anchor.path)
    const host = v && !v.outdated.hidden ? v.outdated : box
    host.hidden = false
    host.append(el)
  }
}
function heading(text: string) {
  const h = document.createElement("div")
  h.className = "outdated-head"
  h.textContent = text
  return h
}
function cardFor(t: Thread) {
  const el = element(t.root.id)
  fillThread(el, t)
  return el
}

// ---------- the file tree ----------

// What the tree's rows show for each file: its change counts, its comments,
// and whether it is viewed. The tree reads this when it draws a row.
type FileStat = { added: number; removed: number; comments: number; viewed: boolean }
let fileStats = new Map<string, FileStat>()
let tree: FileTree | null = null

function gitStatus(f: PatchFile): GitStatusEntry["status"] {
  if (/^new file mode/m.test(f.text)) return "added"
  if (/^deleted file mode/m.test(f.text)) return "deleted"
  if (f.oldPath && f.oldPath !== f.path) return "renamed"
  return "modified"
}
const statuses = () => files.map((f) => ({ path: f.path, status: gitStatus(f) }))

function makeTree() {
  const t = new FileTree({
    paths: files.map((f) => f.path),
    gitStatus: statuses(),
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    search: true,
    density: "compact",
    // a file row scrolls its diff into view; a folder row only opens
    onSelectionChange: (paths) => {
      const i = files.findIndex((f) => f.path === paths[paths.length - 1])
      if (i >= 0) document.getElementById(`file-${i}`)?.scrollIntoView({ block: "start" })
    },
    renderRowDecoration: ({ item }) => {
      const s = item.kind === "file" ? fileStats.get(item.path) : undefined
      if (!s) return null
      const parts = [
        ...(s.viewed ? [{ text: "✓\u00a0", color: "var(--muted)" }] : []),
        ...(s.added ? [{ text: `+${s.added}`, color: "var(--green)" }] : []),
        ...(s.removed ? [{ text: `${s.added ? "\u00a0" : ""}−${s.removed}`, color: "var(--red)" }] : []),
        ...(s.comments ? [{ text: `\u00a0· ${s.comments}`, color: "var(--accent)" }] : []),
      ]
      const title = [
        `+${s.added} −${s.removed}`,
        ...(s.comments ? [`${s.comments} comment${s.comments === 1 ? "" : "s"}`] : []),
        ...(s.viewed ? ["viewed"] : []),
      ].join(" · ")
      return { text: parts.map((x) => x.text).join(""), parts, title }
    },
  })
  t.render({ containerWrapper: $("tree") })
  return t
}

let treePaths = ""
function renderTree(ts: Thread[]) {
  fileStats = new Map(files.map((f) => [f.path, {
    added: f.added,
    removed: f.removed,
    comments: ts.filter((t) => t.root.anchor.path === f.path).length + drafts.filter((d) => d.anchor.path === f.path).length,
    viewed: isViewed(f),
  }]))
  $("files-head").textContent = `${files.length} file${files.length === 1 ? "" : "s"}`
  const paths = files.map((f) => f.path)
  if (!tree) tree = makeTree()
  else if (paths.join("\0") !== treePaths) tree.resetPaths(paths)
  treePaths = paths.join("\0")
  tree.setGitStatus(statuses())
  // The tree has no redraw call, and skips one for an unchanged git status.
  // Setting the labels always redraws, so the rows pick up the new stats.
  tree.setLabels({})
}

function updateBar() {
  if (!diff) return
  $("label").textContent = diff.label
  $("dir").textContent = diff.dir
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  $("stats").textContent = `${files.length} files · +${added} −${removed}`
  $("sink").textContent = snapshot?.sink.kind === "task"
    ? `Comments go to task ${snapshot.sink.task}'s note`
    : snapshot?.agentConnected
    ? "Comments go to the Claude session"
    : "No session yet: comments wait for prose join"
  sendButton.textContent = drafts.length ? `Send review (${drafts.length})` : "Send review"
  sendButton.disabled = drafts.length === 0
}

// Re-renders a file only when its annotations moved; otherwise refills the
// annotation elements in place
function renderAll() {
  const ts = threads()
  for (const v of views) {
    const annotations = annotationsFor(v.file, ts)
    const keys = JSON.stringify(annotations)
    const collapsed = isViewed(v.file)
    if (keys !== v.keys || collapsed !== v.diff.options.collapsed) {
      v.keys = keys
      v.diff.setOptions({ ...v.diff.options, collapsed })
      v.diff.setLineAnnotations(annotations)
      v.diff.rerender()
    }
    v.section.classList.toggle("is-viewed", collapsed)
  }
  fillAnnotations(ts)
  renderOutdated(ts)
  renderTree(ts)
  updateBar()
}

function renderDiff() {
  for (const v of views) v.diff.cleanUp()
  views = []
  const main = $("diff")
  main.replaceChildren()
  files = parsePatch(diff!.patch)
  const ts = threads()
  files.forEach((file, i) => {
    const section = document.createElement("section")
    section.className = "file"
    section.id = `file-${i}`
    const outdated = document.createElement("div")
    outdated.className = "outdated"
    outdated.hidden = true
    const host = document.createElement("div")
    section.append(outdated, host)
    main.append(section)
    // each file on its own, so a file the library can't parse or render,
    // such as one with an unusual name, shows as plain patch text instead of
    // taking the page down
    let meta: FileDiffMetadata | undefined
    try {
      meta = parsePatchFiles(file.text + "\n").flatMap((p) => p.files)[0]
    } catch (error) {
      console.error(`prose diff: can't parse ${file.path}`, error)
    }
    if (!meta) {
      const pre = document.createElement("pre")
      pre.className = "raw-patch"
      pre.textContent = file.text
      host.append(pre)
      return
    }
    const fd = new FileDiff<Meta>({
      diffStyle: "unified",
      themeType: "system",
      lineDiffType: "word",
      collapsed: isViewed(file),
      enableLineSelection: true,
      enableGutterUtility: true,
      lineHoverHighlight: "both",
      // The library keeps the clicked lines selected and pins the + button to
      // the selection's last line, so a later click on + would comment on the
      // same lines. Clearing the selection once the click finishes lets the +
      // follow the pointer.
      onGutterUtilityClick: (range) => {
        openCompose(anchorFor(file, range))
        setTimeout(() => fd.setSelectedLines(null))
      },
      renderHeaderMetadata: () => viewedToggle(file),
      renderAnnotation: (a) => element(a.metadata.id),
    })
    const annotations = annotationsFor(file, ts)
    try {
      fd.render({ fileDiff: meta, lineAnnotations: annotations, containerWrapper: host })
    } catch (error) {
      console.error(`prose diff: can't render ${file.path}`, error)
      fd.cleanUp()
      const pre = document.createElement("pre")
      pre.className = "raw-patch"
      pre.textContent = file.text
      host.replaceChildren(pre)
      return
    }
    views.push({ file, meta, section, outdated, diff: fd, keys: JSON.stringify(annotations) })
  })
  if (!files.length) main.innerHTML = `<p class="empty">No changes.</p>`
  renderAll()
}

async function loadDiff() {
  const response = await fetch("/diff")
  if (!response.ok) {
    showToast(await response.text(), 6000)
    return
  }
  const first = diff === null
  diff = await response.json()
  if (first) {
    drafts = store.get<Draft[]>("drafts", [])
    viewed = new Set(store.get<string[]>("viewed", []))
  }
  $("changed").hidden = true
  renderDiff()
}

// ---------- the diff changing under the page ----------

$("refresh").addEventListener("click", () => void loadDiff())
setInterval(async () => {
  if (document.hidden || !diff) return
  try {
    const { hash } = await (await fetch("/diff/hash")).json()
    $("changed").hidden = hash === diff.hash
  } catch {
    // server restarting; the next poll tries again
  }
}, 4000)

// ---------- the feed: threads and replies ----------

function showAnchor(event: Event) {
  const t = threads().find((x) => x.asks.some((a) => a.id === event.id))
  const el = t && elements.get(t.root.id)
  if (!el?.isConnected) {
    showToast("Those lines are no longer in the diff")
    return
  }
  el.scrollIntoView({ block: "center" })
  el.classList.add("flash")
  setTimeout(() => el.classList.remove("flash"), 1800)
}

function connectFeed() {
  const ws = new WebSocket(`ws://${location.host}/feed`)
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data) as Snapshot & { replay: boolean }
    if (msg.type !== "conversation") return
    const firstSnapshot = snapshot === null
    snapshot = msg
    // the conversation panel carries general messages and every reply, for
    // a session; a task's worker answers in the note
    if (firstSnapshot && msg.sink.kind === "session") conversation = new Conversation(() => {}, showAnchor)
    conversation?.receive(msg, msg.replay)
    if (diff) renderAll()
  }
  ws.onclose = () => {
    conversation?.setConnected(false)
    setTimeout(connectFeed, 1000)
  }
}

await loadDiff()
connectFeed()
