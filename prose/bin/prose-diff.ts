// prose's diff review server: a unified diff of a checkout in the browser,
// with line comments that go to a Claude Code session, or to a fleet task's
// note. The page re-reads the diff when asked and polls for changes; the
// server never pushes a new diff, so a comment being written never moves.
// Browser code lives in prose-diff-client.ts, bundled at startup. The
// skill's "Diff reviews" section says how a session handles the events.
//
//   prose-diff.ts [--port N] [--no-open] [--socket P] [--dir D] [--git-args JSON]
//   prose-diff.ts --task ID --fleet NAME --note PATH [--port N] [--no-open]
//
// --git-args is a JSON array of git diff arguments, one option so prose-bg
// can append --port after it.

import { parseArgs } from "@std/cli/parse-args"
import { dirname, fromFileUrl, join } from "@std/path"
import { ActivityLog, InputError, parseActivity, parseUser, type UserInput } from "./lib/prose/events.ts"
import { DiffSource } from "./lib/prose/diffsource.ts"
import { DiffReview, type Sink } from "./lib/prose/review.ts"
import { resolveSession } from "./lib/prose/session.ts"

const flags = parseArgs(Deno.args, {
  string: ["port", "socket", "dir", "task", "fleet", "note", "git-args"],
  boolean: ["open"],
  default: { port: "4917", open: true },
  negatable: ["open"],
})
const gitArgs: string[] = flags["git-args"] ? JSON.parse(flags["git-args"]) : []
if (!Array.isArray(gitArgs) || !gitArgs.every((a) => typeof a === "string")) {
  throw new Error("--git-args takes a JSON array of strings")
}
const port = Number(flags.port)

const binDir = dirname(await Deno.realPath(fromFileUrl(import.meta.url)))

let source: DiffSource
let sink: Sink
if (flags.task) {
  if (!flags.fleet || !flags.note) throw new Error("--task needs --fleet and --note")
  source = new DiffSource({ kind: "task", fleet: flags.fleet, task: flags.task })
  sink = { kind: "task", fleet: flags.fleet, task: flags.task, note: await Deno.realPath(flags.note) }
} else {
  const dir = (await new Deno.Command("git", {
    args: ["-C", flags.dir ?? Deno.cwd(), "rev-parse", "--show-toplevel"],
    stdout: "piped",
  }).output())
  if (!dir.success) throw new Error(`not a git checkout: ${flags.dir ?? Deno.cwd()}`)
  source = new DiffSource({ kind: "git", dir: new TextDecoder().decode(dir.stdout).trim(), args: gitArgs })
  sink = { kind: "session" }
}
// fail before binding the port when git or fleet can't produce the diff
const first = await source.read()

// One log per review under XDG state, as prose keeps one per markdown file
const stateDir = join(Deno.env.get("XDG_STATE_HOME") ?? join(Deno.env.get("HOME")!, ".local", "state"), "prose")
await Deno.mkdir(stateDir, { recursive: true })
const keyHash = [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(source.key)))]
  .slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("")
const commentLog = join(stateDir, `diff-${source.key.replace(/[^\w.-]+/g, "-").slice(0, 80)}-${keyHash}.comments.jsonl`)
const session = sink.kind === "session" ? resolveSession(flags.socket) : null
const review = new DiffReview(source.key, await ActivityLog.open(commentLog, source.key), sink, {
  session,
  port,
  dir: first.dir,
  label: first.label,
})

// Pages carry this token, and the endpoints that send text to the agent
// take nothing without it, so another site open in the browser can't reach
// them even past the origin checks below. A local process can still read the
// page, as it can still write to the session's socket itself.
const token = crypto.randomUUID()

async function buildClientBundle(): Promise<string> {
  const clientPath = join(binDir, "prose-diff-client.ts")
  const config = join(dirname(binDir), "deno.jsonc")
  const run = async (args: string[]) => {
    const out = await new Deno.Command(Deno.execPath(), { args, stderr: "piped" }).output()
    if (!out.success) throw new Error(`${args[0]} failed:\n${new TextDecoder().decode(out.stderr)}`)
  }
  // deno bundle doesn't fetch missing npm packages itself
  await run(["cache", "--config", config, clientPath])
  const outFile = await Deno.makeTempFile({ prefix: "prose-diff-bundle-", suffix: ".js" })
  try {
    await run(["bundle", "--quiet", "--minify", "--platform", "browser", "--config", config, "--output", outFile, clientPath])
    return await Deno.readTextFile(outFile)
  } finally {
    await Deno.remove(outFile).catch(() => {})
  }
}
const bundleJs = buildClientBundle()
bundleJs.catch((error) => {
  console.error("prose diff: client bundle failed", error)
  Deno.exit(1)
})
const [conversationCss, diffCss] = await Promise.all([
  Deno.readTextFile(join(binDir, "lib", "prose", "conversation.css")),
  Deno.readTextFile(join(binDir, "lib", "prose", "diff.css")),
])

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

function page() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; frame-src 'none'; object-src 'none'">
<meta name="prose-token" content="${token}">
<title>${esc(first.label)}</title>
<link rel="stylesheet" href="/conversation.css">
<link rel="stylesheet" href="/diff.css">
</head>
<body>
<header id="bar">
  <div class="bar-title"><strong id="label"></strong> <span id="dir"></span></div>
  <div class="bar-stats" id="stats"></div>
  <div class="bar-sink" id="sink"></div>
  <button id="send-review" type="button" disabled>Send review</button>
</header>
<div id="changed" hidden><span>The diff changed.</span> <button id="refresh" type="button">Refresh</button></div>
<div id="layout">
<aside id="files"><div id="files-head">Files</div><div id="tree"></div></aside>
<div id="content">
<section id="orphans" hidden></section>
<main id="diff"></main>
</div>
</div>
<div id="toast"></div>
<script type="module" src="/bundle.js"></script>
</body>
</html>`
}

const selfOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`])
const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`])
const json = (value: unknown, status = 200) => Response.json(value, { status })
const css = (text: string) => new Response(text, { headers: { "content-type": "text/css; charset=utf-8" } })

function failure(error: unknown) {
  if (error instanceof InputError) return new Response(error.message, { status: error.status })
  if (error instanceof SyntaxError) return new Response("Invalid JSON", { status: 400 })
  console.error("prose diff:", error)
  return new Response(error instanceof Error ? error.message : String(error), { status: 500 })
}

Deno.serve({ port, hostname: "127.0.0.1" }, async (req) => {
  const { pathname } = new URL(req.url)
  // the same checks as prose's markdown server: only this server's own page
  // and local tools, which send no Origin, get through
  const origin = req.headers.get("origin")
  const host = req.headers.get("host")
  const site = req.headers.get("sec-fetch-site")
  if (
    (origin && !selfOrigins.has(origin)) || (host && !allowedHosts.has(host)) ||
    (site && site !== "same-origin" && site !== "none")
  ) {
    return new Response("forbidden", { status: 403 })
  }
  try {
    if (pathname === "/") return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } })
    if (pathname === "/bundle.js") {
      return new Response(await bundleJs, { headers: { "content-type": "text/javascript; charset=utf-8" } })
    }
    if (pathname === "/favicon.ico") return new Response(null, { status: 204 })
    if (pathname === "/conversation.css") return css(conversationCss)
    if (pathname === "/diff.css") return css(diffCss)
    if (pathname === "/diff") return json({ key: source.key, ...(await source.read()) })
    if (pathname === "/diff/hash") return json({ hash: (await source.read()).hash })
    if (pathname === "/feed") {
      const { socket, response } = Deno.upgradeWebSocket(req)
      socket.onopen = () => review.addClient(socket)
      socket.onclose = () => review.clients.delete(socket)
      socket.onerror = () => review.clients.delete(socket)
      return response
    }
    // prose pending and prose respond find a server's reviews here, by the
    // name its log records
    if (pathname === "/docs") return json([source.key])
    if (pathname === "/activity" && req.method === "GET") {
      return new Response(review.snapshot(false), { headers: { "content-type": "application/json" } })
    }
    if (pathname === "/activity" && req.method === "POST") {
      const { event } = await review.postActivity(parseActivity(await req.json()))
      return json({ event, agentConnected: false })
    }
    if ((pathname === "/comment" || pathname === "/review") && req.method === "POST") {
      if (req.headers.get("x-prose-token") !== token) return new Response("forbidden", { status: 403 })
      const body = await req.json()
      const inputs: UserInput[] = pathname === "/comment"
        ? [parseUser(body)]
        : Array.isArray(body?.comments)
        ? body.comments.map(parseUser)
        : []
      if (inputs.length > 200) throw new InputError("Send at most 200 comments at once")
      const { events, delivered, warning } = await review.review(inputs)
      // saved counts the comments kept, in the order sent, which a partly
      // failed task review needs so the page keeps the rest as drafts
      return json({ event: events[0], events, saved: events.length, agentConnected: delivered, warning })
    }
    if (pathname === "/session" && req.method === "POST") {
      if (sink.kind !== "session") return new Response("a task review sends comments to the task's note", { status: 400 })
      const { socket, token: auth } = await req.json()
      if (typeof socket !== "string" || !(await Deno.stat(socket)).isSocket) {
        return new Response("socket must be a session's inbox socket", { status: 400 })
      }
      const sent = await review.join({ socket, token: typeof auth === "string" ? auth : undefined })
      console.log(`comments now go to session socket ${socket}; sent ${sent} held`)
      return json({ socket, sent })
    }
    return new Response("not found", { status: 404 })
  } catch (error) {
    return failure(error)
  }
})

const url = `http://localhost:${port}`
console.log(`reviewing ${first.label} in ${first.dir} at ${url}`)
console.log(
  sink.kind === "task"
    ? `comments go to ${sink.note} (fleet ${sink.fleet}, task ${sink.task})`
    : session
    ? `comments go to session socket ${session.socket} (logged to ${commentLog})`
    : `no session socket; comments are held in ${commentLog} until a session runs prose join ${port}`,
)
if (flags.open) {
  await bundleJs
  await new Deno.Command("open", { args: [url] }).output()
}
