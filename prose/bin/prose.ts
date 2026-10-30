#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-net=127.0.0.1,localhost,github.com,raw.githubusercontent.com,private-user-images.githubusercontent.com --allow-run=open,deno,gh,python3,hx,nc

// Local review GUI for a markdown file: GitHub-style live preview, a
// collapsible pane running real helix on the file (hx in a pty, rendered by
// xterm.js), and selection comments that flow back into the Claude Code
// session that launched the server, over that session's inbox socket (see
// lib/prose/session.ts).
//
// The file on disk is the only document. Helix auto-saves shortly after
// typing stops; Claude edits the file directly; a watcher pushes every disk
// change to the preview. Browser code lives in prose-client.ts, bundled at
// startup. Orchestrated by the prose skill.

import { Command } from "@cliffy/command"
import { basename, dirname, fromFileUrl, join } from "@std/path"
import { InputError, parseActivity, parseUser } from "./lib/prose/events.ts"
import { allowed, DocSet, isMarkdown } from "./lib/prose/docs.ts"
import { resolveSession } from "./lib/prose/session.ts"

// Helix gets a temp config: the user's config.toml (if any) plus auto-save, so
// the preview updates shortly after typing stops, and auto-reload, so the pane
// picks up Claude's edits to the file instead of going stale. `hx --config`
// replaces config.toml entirely, which is why we concatenate rather than
// override. Steel config (init.scm) still loads from the normal location.
//
// auto-reload is not upstream helix: it's the `auto-reload` branch of the
// local fork (a port of helix-editor/helix#13963 that reloads unmodified
// buffers silently). With `merge`, buffers with unsaved edits get a three-way
// merge of disk into the buffer; overlapping edits are left as conflict
// markers to resolve in place.
const AUTO_SAVE = `
[editor.auto-save]
focus-lost = true

[editor.auto-save.after-delay]
enable = true
timeout = 650
`

const AUTO_RELOAD = `
[editor.auto-reload]
focus-gained = true
merge = true

[editor.auto-reload.periodic]
enable = true
interval = 300
`

async function writeHelixConfig(): Promise<string> {
  let userConfig = ""
  try {
    userConfig = await Deno.readTextFile(
      join(Deno.env.get("HOME")!, ".config/helix/config.toml"),
    )
  } catch {
    // no user config; auto-save section alone is fine
  }
  const path = await Deno.makeTempFile({ prefix: "prose-hx-", suffix: ".toml" })
  let config = userConfig
  if (!config.includes("[editor.auto-save")) config += AUTO_SAVE
  if (!config.includes("[editor.auto-reload")) config += AUTO_RELOAD
  await Deno.writeTextFile(path, config)
  return path
}

// Without hx on PATH the editor pane can only fail, so every page is served
// preview-only. Deno throws NotFound (or PermissionDenied, when --allow-run
// could not resolve hx at startup) rather than returning a failed status.
async function hxInstalled(): Promise<boolean> {
  try {
    const out = await new Deno.Command("hx", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    })
      .output()
    return out.success
  } catch {
    return false
  }
}

function page(title: string, previewOnly: boolean) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; media-src *; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; frame-src 'none'; object-src 'none'">
<title>${title}</title>
<link rel="stylesheet" href="/github-markdown.css">
<link rel="stylesheet" href="/xterm.css">
<link rel="stylesheet" href="/conversation.css">
<style>
  body { margin: 0; background-color: #ffffff; }
  @media (prefers-color-scheme: dark) { body { background-color: #0d1117; } }
  #layout { display: grid; grid-template-columns: 1fr; }
  body.editor-shown #layout { grid-template-columns: minmax(0, 45%) minmax(0, 1fr); }
  #editor-pane {
    display: none;
    position: sticky;
    top: 0;
    align-self: start;
    box-sizing: border-box;
    height: 100vh;
    overflow: hidden;
    padding: 6px 0 6px 6px;
    background: #020202; /* ayu_evolve background, so the pane's padding matches helix */
    border-right: 1px solid #d1d9e0;
  }
  body.editor-shown #editor-pane { display: block; }
  #editor-host { height: 100%; }
  #editor-host .xterm { height: 100%; }
  .markdown-body {
    box-sizing: border-box;
    min-width: 200px;
    max-width: 830px;
    margin: 0 auto;
    padding: 45px;
  }
  #editor-toggle {
    position: fixed;
    top: 10px;
    right: 10px;
    z-index: 11;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid #d1d9e0;
    border-radius: 6px;
    background: #f6f8fa;
    color: #59636e;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }
  #editor-toggle:hover { color: #1f2328; background: #eef1f4; }
  @keyframes flash-fade {
    from { background-color: rgba(255, 223, 93, 0.5); }
    to { background-color: transparent; }
  }
  #content .flash { animation: flash-fade 1.8s ease-out; }
  #content .flash-inline { animation: flash-fade 1.8s ease-out; border-radius: 2px; }
  /* jj/git conflict regions: each side rendered as markdown in a labelled box */
  .conflict { border: 1px solid #d1d9e0; border-left: 3px solid #bf8700; border-radius: 6px; margin-bottom: 16px; overflow: hidden; }
  .conflict-title {
    padding: 6px 16px;
    background: #f6f8fa;
    border-bottom: 1px solid #d1d9e0;
    font-size: 12px;
    font-weight: 600;
    color: #9a6700;
  }
  .conflict-panel { padding: 12px 16px; }
  .conflict-panel + .conflict-panel { border-top: 1px dashed #d1d9e0; }
  .conflict-panel[data-kind="base"] { background: #f6f8fa; color: #59636e; }
  .conflict-label { font-size: 12px; font-weight: 600; color: #59636e; margin-bottom: 6px; }
  .conflict-panel[data-kind="side"] .conflict-label { color: #0969da; }
  .conflict-body > :last-child { margin-bottom: 0 !important; }
  .conflict-added { background: #dafbe1; border-radius: 2px; }
  .conflict-removed { background: #ffebe9; border-radius: 2px; }
  /* GitHub-style embeds (permalink snippets, assets) */
  .gh-embed img, .gh-embed video { max-width: 100%; }
  .gh-embed { margin-bottom: 16px; }
  .gh-embed-error { color: #d1242f; font-size: 13px; }
  .gh-blob { border: 1px solid #d1d9e0; border-radius: 6px; margin-bottom: 16px; overflow: hidden; }
  .gh-blob-header {
    padding: 8px 16px;
    background: #f6f8fa;
    border-bottom: 1px solid #d1d9e0;
    font-size: 12px;
    color: #59636e;
  }
  .gh-blob-header a { font-weight: 600; }
  .gh-blob-body { display: flex; }
  .gh-blob-body pre {
    margin: 0 !important;
    border-radius: 0 !important;
    background: transparent !important;
    font-size: 12px !important;
    line-height: 20px;
  }
  .gh-blob-body > pre:last-child { flex: 1; min-width: 0; overflow-x: auto; }
  .gh-blob-gutter { color: #59636e; text-align: right; user-select: none; padding-right: 0 !important; }
  @media (prefers-color-scheme: dark) {
    .gh-embed-error { color: #f85149; }
    .conflict { border-color: #3d444d; border-left-color: #9e6a03; }
    .conflict-title { background: #151b23; border-color: #3d444d; color: #d29922; }
    .conflict-panel + .conflict-panel { border-color: #3d444d; }
    .conflict-panel[data-kind="base"] { background: #151b23; color: #9198a1; }
    .conflict-label { color: #9198a1; }
    .conflict-panel[data-kind="side"] .conflict-label { color: #58a6ff; }
    .conflict-added { background: #2ea04333; }
    .conflict-removed { background: #f8514933; }
    .gh-blob { border-color: #3d444d; }
    .gh-blob-header { background: #151b23; border-color: #3d444d; color: #9198a1; }
    .gh-blob-gutter { color: #9198a1; }
  }
  /* lezer classHighlighter tokens in preview code blocks (GitHub palette) */
  .tok-keyword, .tok-operator, .tok-modifier { color: #cf222e; }
  .tok-string, .tok-string2, .tok-regexp { color: #0a3069; }
  .tok-comment, .tok-meta { color: #59636e; }
  .tok-number, .tok-bool, .tok-literal, .tok-atom, .tok-constant { color: #0550ae; }
  .tok-typeName, .tok-className, .tok-tagName, .tok-standard { color: #953800; }
  .tok-function, .tok-macroName { color: #8250df; }
  .tok-propertyName, .tok-attributeName, .tok-definition { color: #0550ae; }
  .tok-heading { font-weight: 600; }
  .tok-link { text-decoration: underline; }
  @media (prefers-color-scheme: dark) {
    .tok-keyword, .tok-operator, .tok-modifier { color: #ff7b72; }
    .tok-string, .tok-string2, .tok-regexp { color: #a5d6ff; }
    .tok-comment, .tok-meta { color: #9198a1; }
    .tok-number, .tok-bool, .tok-literal, .tok-atom, .tok-constant { color: #79c0ff; }
    .tok-typeName, .tok-className, .tok-tagName, .tok-standard { color: #ffa657; }
    .tok-function, .tok-macroName { color: #d2a8ff; }
    .tok-propertyName, .tok-attributeName, .tok-definition { color: #79c0ff; }
  }
  #popover {
    position: absolute;
    z-index: 10;
    display: none;
    flex-direction: column;
    gap: 8px;
    box-sizing: border-box;
    width: 366px;
    max-width: calc(100vw - 16px);
    padding: 12px;
    border: 1px solid #d1d9e0;
    border-radius: 12px;
    background: #ffffff;
    box-shadow: 0 8px 24px rgba(140, 149, 159, 0.2);
    font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  #popover textarea {
    resize: vertical;
    min-height: 60px;
    font: inherit;
    line-height: 1.4;
    padding: 8px;
    border: 1px solid #d1d9e0;
    border-radius: 6px;
    background: #f6f8fa;
    color: #1f2328;
    outline: none;
    transition: border-color 0.1s, box-shadow 0.1s;
  }
  #popover textarea:focus {
    background: #ffffff;
    border-color: #0969da;
    box-shadow: 0 0 0 3px rgba(9, 105, 218, 0.3);
  }
  #popover textarea::placeholder { color: #818b98; }
  #popover .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  #popover .hint { color: #59636e; font-size: 11px; flex: 1; text-align: right; }
  #popover button {
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.1s, border-color 0.1s;
  }
  #popover #dellm {
    background: transparent;
    border: 1px solid #d1d9e0;
    color: #59636e;
  }
  #popover #dellm:hover { color: #1f2328; border-color: #818b98; background: #f6f8fa; }
  #popover #send {
    background: #1f883d;
    border: 1px solid rgba(31, 35, 40, 0.15);
    color: #ffffff;
  }
  #popover #send:hover { background: #1a7f37; }
  #toast {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    padding: 6px 14px;
    border-radius: 6px;
    background: #1f883d;
    color: white;
    font: 13px -apple-system, sans-serif;
    opacity: 0;
    transition: opacity 0.3s;
    pointer-events: none;
  }
  ::highlight(pending-comment) { background-color: rgba(84, 174, 255, 0.4); }
  ::highlight(conversation-anchor) { background-color: rgba(84, 174, 255, 0.4); }
  @media (prefers-color-scheme: dark) {
    #editor-pane { border-right-color: #3d444d; }
    #editor-toggle {
      background: #151b23;
      border-color: #3d444d;
      color: #9198a1;
      color-scheme: dark;
    }
    #editor-toggle:hover { color: #f0f6fc; background: #1c2330; }
    @keyframes flash-fade {
      from { background-color: rgba(187, 128, 9, 0.4); }
      to { background-color: transparent; }
    }
    #popover { background: #151b23; border-color: #3d444d; box-shadow: 0 8px 24px #010409; color: #f0f6fc; }
    #popover textarea { background: #0d1117; color: #f0f6fc; border-color: #3d444d; }
    #popover textarea:focus {
      background: #0d1117;
      border-color: #1f6feb;
      box-shadow: 0 0 0 3px rgba(31, 111, 235, 0.35);
    }
    #popover textarea::placeholder { color: #656c76; }
    #popover .hint { color: #9198a1; }
    #popover #dellm { border-color: #3d444d; color: #9198a1; }
    #popover #dellm:hover { color: #f0f6fc; border-color: #656c76; background: #151b23; }
    #popover #send { background: #238636; border-color: rgba(240, 246, 252, 0.1); }
    #popover #send:hover { background: #29903b; }
  }
</style>
</head>
<body${previewOnly ? ' class="preview-only"' : ""}>
<div id="layout">
  ${previewOnly ? "" : '<div id="editor-pane"><div id="editor-host"></div></div>'}
  <div id="preview-pane"><article class="markdown-body" id="content"></article></div>
</div>
${
    previewOnly
      ? ""
      : '<button id="editor-toggle" aria-label="Toggle helix editor" title="Toggle helix editor (⌘E)">✎</button>'
  }
<div id="popover">
  <textarea id="comment-text" placeholder="Comment for Claude"></textarea>
  <div class="row">
    <button id="dellm" title="Rewrite the selection to sound like a person; comment text (if any) is extra guidance">de-LLM</button>
    <span class="hint">⌘⏎ to send · esc to cancel</span>
    <button id="send">Send</button>
  </div>
</div>
<div id="toast"></div>
<script type="module" src="/bundle.js"></script>
</body>
</html>`
}

// deno bundle doesn't fetch missing npm packages itself, so cache first
// (a fast no-op once the packages are in deno's cache).
async function buildClientBundle(binDir: string): Promise<string> {
  const clientPath = join(binDir, "prose-client.ts")
  const config = join(dirname(binDir), "deno.jsonc")
  const run = async (args: string[]) => {
    const out = await new Deno.Command(Deno.execPath(), { args, stderr: "piped" }).output()
    if (!out.success) {
      throw new Error(`${args[0]} failed:\n${new TextDecoder().decode(out.stderr)}`)
    }
  }
  await run(["cache", "--config", config, clientPath])
  const outFile = await Deno.makeTempFile({ prefix: "prose-bundle-", suffix: ".js" })
  try {
    await run([
      "bundle",
      "--quiet",
      "--platform",
      "browser",
      "--config",
      config,
      "--output",
      outFile,
      clientPath,
    ])
    return await Deno.readTextFile(outFile)
  } finally {
    await Deno.remove(outFile).catch(() => {})
  }
}

// ---------- GitHub embeds ----------

let ghTokenPromise: Promise<string | null> | undefined
function ghToken(): Promise<string | null> {
  ghTokenPromise ??= new Deno.Command("gh", { args: ["auth", "token"], stderr: "null" })
    .output()
    .then((o) => (o.success ? new TextDecoder().decode(o.stdout).trim() || null : null))
    .catch(() => null)
  return ghTokenPromise
}

async function ghHeaders(): Promise<HeadersInit> {
  const token = await ghToken()
  return token ? { authorization: `Bearer ${token}` } : {}
}

const cacheDir = join(
  Deno.env.get("XDG_CACHE_HOME") ?? join(Deno.env.get("HOME")!, ".cache"),
  "prose",
)

// File contents at a ref. A full commit sha is immutable, so those are cached
// on disk forever; branch names and short shas are fetched every time.
async function fetchBlob(owner: string, repo: string, ref: string, path: string) {
  const immutable = /^[0-9a-f]{40}$/.test(ref)
  const cachePath = join(cacheDir, "blobs", owner, repo, ref, path)
  if (immutable) {
    try {
      return await Deno.readTextFile(cachePath)
    } catch {
      // not cached
    }
  }
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`
  const res = await fetch(url, { headers: await ghHeaders() })
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`)
  const text = await res.text()
  if (immutable) {
    await Deno.mkdir(dirname(cachePath), { recursive: true })
    await Deno.writeTextFile(cachePath, text)
  }
  return text
}

// github.com/user-attachments/assets/<id> redirects to a signed S3 URL that
// works for a few minutes. Resolve it server-side and hand the browser that
// URL, so the bytes never pass through here. Redirects are followed only
// within the allowlisted hosts (the shebang's --allow-net); the final S3
// hostname varies, so the type comes from the redirect URL rather than a
// response header. No auth: public-repo assets need none, and private ones
// are gated on a browser session (a JWT-signed private-user-images URL)
// that a token can't replace.
const assetHosts = ["github.com", "private-user-images.githubusercontent.com"]
async function resolveAsset(url: string) {
  for (let hops = 0; hops < 5; hops++) {
    const u = new URL(url)
    if (!assetHosts.includes(u.hostname)) {
      const type = u.searchParams.get("response-content-type") ??
        mimeTypes[u.pathname.split(".").pop()?.toLowerCase() ?? ""] ?? ""
      return { src: url, type }
    }
    const res = await fetch(url, { redirect: "manual" })
    await res.body?.cancel()
    const location = res.headers.get("location")
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url).href
      continue
    }
    if (!res.ok) throw new Error(`${res.status} fetching ${url}`)
    throw new Error(`asset not accessible: ${url}`)
  }
  throw new Error(`too many redirects: ${url}`)
}

const mimeTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
}

// ---------- helix in a pty ----------

// stdin frame for prose-pty.py: type byte, u32 BE length, payload
function frame(kind: "i" | "r", payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(5 + payload.length)
  buf[0] = kind.charCodeAt(0)
  new DataView(buf.buffer).setUint32(1, payload.length)
  buf.set(payload, 5)
  return buf
}

type PtyMessage = { type: "input"; data: string } | { type: "redraw" } | {
  type: "resize"
  cols: number
  rows: number
}

// One helix per WebSocket: spawned when the page opens its editor pane, hung
// up when the socket closes (page reload or close). Output is relayed as
// binary frames; input and resizes arrive as JSON text frames.
function servePty(
  req: Request,
  opts: { binDir: string; hxConfig: string; file: string; port: number },
): Response {
  const q = new URL(req.url).searchParams
  let cols = Math.max(20, Number(q.get("cols")) || 80)
  let rows = Math.max(5, Number(q.get("rows")) || 24)
  const { socket, response } = Deno.upgradeWebSocket(req)
  const enc = new TextEncoder()
  let proc: Deno.ChildProcess | null = null
  let stdin: WritableStreamDefaultWriter<Uint8Array> | null = null
  let sendQueue: Promise<void> = Promise.resolve()
  const write = (buf: Uint8Array) => {
    // Serialize writes: a resize during a burst of typing must not interleave
    // with a partially written input frame.
    sendQueue = sendQueue.then(() => stdin?.write(buf)).catch(() => {})
  }

  socket.onopen = () => {
    proc = new Deno.Command("python3", {
      args: [
        join(opts.binDir, "prose-pty.py"),
        `${cols}x${rows}`,
        "hx",
        "--config",
        opts.hxConfig,
        opts.file,
      ],
      cwd: dirname(opts.file),
      env: {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        // for helix-side integrations (Steel) that want to talk to this server
        PROSE_PORT: String(opts.port),
        PROSE_FILE: opts.file,
      },
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    }).spawn()
    stdin = proc.stdin.getWriter()
    console.log(`helix started (pid ${proc.pid}, ${cols}x${rows})`)
    ;(async () => {
      try {
        for await (const chunk of proc.stdout) {
          if (socket.readyState === WebSocket.OPEN) socket.send(chunk)
        }
      } catch {
        // socket closed mid-stream
      }
      const status = await proc.status
      console.log(`helix exited (${status.code})`)
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "helix exited")
    })()
  }
  socket.onmessage = (e) => {
    if (typeof e.data !== "string") return
    const msg = JSON.parse(e.data) as PtyMessage
    if (msg.type === "input") write(frame("i", enc.encode(msg.data)))
    else if (msg.type === "resize") {
      ;({ cols, rows } = msg)
      write(frame("r", enc.encode(`${cols}x${rows}`)))
    } else if (msg.type === "redraw") {
      // Same-size resize: the helper still raises SIGWINCH, and helix clears
      // and repaints everything on any resize event.
      console.log(`redraw requested by the page (${cols}x${rows})`)
      write(frame("r", enc.encode(`${cols}x${rows}`)))
    }
  }
  const hangup = () => {
    // Closing stdin makes the helper SIGHUP helix
    sendQueue = sendQueue.then(() => stdin?.close()).catch(() => {})
  }
  socket.onclose = hangup
  socket.onerror = hangup
  return response
}

await new Command()
  .name("prose")
  .description(
    "Serve a markdown file as a live GitHub-style preview with review comments and a helix pane",
  )
  .arguments("<file:string>")
  .option("-p, --port <port:number>", "Port to listen on", { default: 4917 })
  .option("--no-open", "Don't open the browser")
  .option(
    "--socket <path:string>",
    "Session inbox socket to post comments to (default: $CLAUDE_CODE_MESSAGING_SOCKET)",
  )
  .action(async ({ port, open, socket: socketFlag }, file) => {
    await Deno.stat(file) // fail fast on bad path

    const binDir = dirname(await Deno.realPath(fromFileUrl(import.meta.url)))
    const [markdownCss, xtermCss, conversationCss, hxConfig] = await Promise.all([
      Deno.readTextFile(join(binDir, "lib", "github-markdown.min.css")),
      Deno.readTextFile(join(binDir, "lib", "xterm.css")),
      Deno.readTextFile(join(binDir, "lib", "prose", "conversation.css")),
      writeHelixConfig(),
    ])
    const hasHelix = await hxInstalled()
    if (!hasHelix) console.log("hx not found; serving preview-only")
    // Bundling takes a couple of seconds. Bind the port first so the page
    // loads right away; /bundle.js awaits the build.
    const bundleJs = buildClientBundle(binDir)
    bundleJs.catch((error) => {
      console.error("prose: client bundle failed", error)
      Deno.exit(1)
    })

    // Comment logs live under XDG state; see Doc.open
    const stateDir = join(
      Deno.env.get("XDG_STATE_HOME") ??
        join(Deno.env.get("HOME")!, ".local", "state"),
      "prose",
    )
    await Deno.mkdir(stateDir, { recursive: true })
    const session = resolveSession(socketFlag)
    const docs = new DocSet(stateDir, { session, port })
    const primary = await docs.start(file)
    const absFile = primary.file

    // Only the page this server serves may talk to it. Browsers send Origin
    // on POSTs and WebSocket upgrades, so a cross-site page can't inject
    // comments into the session or type into helix; the Host check blocks
    // DNS rebinding. Sec-Fetch-Site also covers the requests that carry no
    // Origin, such as a cross-site link navigating to /?file=<any path>: only
    // same-origin requests and ones the user started (typed URL, `open`)
    // pass. Non-browser clients (curl from the session) send none of these.
    const selfOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`])
    const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`])

    // A request's doc, from ?file= or the primary file, or the error response
    const docFor = async (searchParams: URLSearchParams) => {
      try {
        return await docs.forRequest(searchParams)
      } catch (e) {
        return new Response(e instanceof Error ? e.message : String(e), { status: 404 })
      }
    }

    Deno.serve({ port, hostname: "127.0.0.1" }, async (req) => {
      const { pathname, searchParams } = new URL(req.url)
      const origin = req.headers.get("origin")
      const host = req.headers.get("host")
      const site = req.headers.get("sec-fetch-site")
      if (
        (origin && !selfOrigins.has(origin)) || (host && !allowedHosts.has(host)) ||
        (site && site !== "same-origin" && site !== "none")
      ) {
        return new Response("forbidden", { status: 403 })
      }
      if (pathname === "/") {
        const doc = await docFor(searchParams)
        if (doc instanceof Response) return doc
        // ?preview renders only the markdown pane, for terminal-browser
        // setups where helix runs in a sibling terminal pane (prose-tab)
        return new Response(
          page(basename(doc.file), searchParams.has("preview") || !hasHelix),
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        )
      }
      // A link in a doc to another local file. Markdown opens here as another
      // doc, in place, so the browser's history works; anything else is served
      // raw through /local. The path resolves against the linking doc's folder.
      if (pathname === "/follow") {
        const from = await docFor(new URLSearchParams({ file: searchParams.get("from") ?? "" }))
        if (from instanceof Response) return from
        const [path, hash] = (searchParams.get("path") ?? "").split("#", 2)
        const resolved = path.startsWith("/") ? path : join(dirname(from.file), decodeURIComponent(path))
        if (!isMarkdown(resolved)) {
          const ext = resolved.split(".").pop()?.toLowerCase() ?? ""
          if (!(ext in mimeTypes)) {
            return new Response("prose opens linked markdown and media files only", { status: 404 })
          }
          return Response.redirect(
            `http://${host}/local?${new URLSearchParams({ file: from.file, path })}`,
            302,
          )
        }
        try {
          const doc = await docs.get(resolved)
          return Response.redirect(
            `http://${host}/?${new URLSearchParams({ file: doc.file })}${hash ? `#${hash}` : ""}`,
            302,
          )
        } catch (e) {
          return new Response(e instanceof Error ? e.message : String(e), { status: 404 })
        }
      }
      if (pathname === "/bundle.js") {
        return new Response(await bundleJs, {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        })
      }
      if (pathname === "/conversation.css") {
        return new Response(conversationCss, {
          headers: { "content-type": "text/css; charset=utf-8" },
        })
      }
      if (pathname === "/github-markdown.css" || pathname === "/xterm.css") {
        return new Response(pathname === "/xterm.css" ? xtermCss : markdownCss, {
          headers: { "content-type": "text/css; charset=utf-8" },
        })
      }
      // Embeds: GitHub permalink contents, resolved asset URLs, and local
      // images referenced from the draft (see prose-client.ts hydrateEmbeds).
      if (pathname === "/gh/blob") {
        const args = ["owner", "repo", "ref", "path"].map((k) => searchParams.get(k) ?? "")
        // Each becomes a cache path segment, so no traversal or separators
        const segment = /^(?!\.\.?$)[\w.-]+$/
        const valid = args.slice(0, 3).every((a) => segment.test(a)) &&
          args[3].split("/").every((a) => segment.test(a))
        if (!valid) return new Response("bad request", { status: 400 })
        try {
          const [owner, repo, ref, path] = args
          return new Response(await fetchBlob(owner, repo, ref, path), {
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
        } catch (e) {
          return new Response(e instanceof Error ? e.message : String(e), { status: 502 })
        }
      }
      if (pathname === "/gh/asset") {
        const url = searchParams.get("url") ?? ""
        try {
          return Response.json(await resolveAsset(url))
        } catch (e) {
          return new Response(e instanceof Error ? e.message : String(e), { status: 502 })
        }
      }
      if (pathname === "/local") {
        const doc = await docFor(searchParams)
        if (doc instanceof Response) return doc
        const p = searchParams.get("path") ?? ""
        const resolved = p.startsWith("/") ? p : join(dirname(doc.file), p)
        let real: string
        try {
          real = await Deno.realPath(resolved)
        } catch {
          return new Response("not found", { status: 404 })
        }
        // Media only, where allowed() lets docs open (under $HOME or beside
        // the draft, and not into a dot folder). The sandbox header keeps an
        // SVG opened directly from running scripts on this origin, which
        // could otherwise post comments into the session.
        const ext = real.split(".").pop()?.toLowerCase() ?? ""
        if (!(ext in mimeTypes) || !allowed(real, absFile)) {
          return new Response("forbidden", { status: 403 })
        }
        const f = await Deno.open(real)
        return new Response(f.readable, {
          headers: {
            "content-type": mimeTypes[ext],
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          },
        })
      }
      // The preview subscribes here: current file text on connect and after
      // every change on disk.
      if (pathname === "/doc") {
        const doc = await docFor(searchParams)
        if (doc instanceof Response) return doc
        const { socket, response } = Deno.upgradeWebSocket(req)
        socket.onopen = () => doc.addClient(socket)
        socket.onclose = () => doc.clients.delete(socket)
        socket.onerror = () => doc.clients.delete(socket)
        return response
      }
      if (pathname === "/pty") {
        if (!hasHelix) return new Response("hx not installed", { status: 404 })
        const doc = await docFor(searchParams)
        if (doc instanceof Response) return doc
        return servePty(req, { binDir, hxConfig, file: doc.file, port })
      }
      // prose join: a session takes over this server's docs, gets the held
      // requests, and receives everything after. Only the prose tools call
      // this; the browser checks above keep pages from it.
      if (pathname === "/session" && req.method === "POST") {
        try {
          const { socket, token } = await req.json()
          if (typeof socket !== "string" || !(await Deno.stat(socket)).isSocket) {
            return new Response("socket must be a session's inbox socket", { status: 400 })
          }
          const sent = await docs.join({ socket, token: typeof token === "string" ? token : undefined })
          console.log(`comments now go to session socket ${socket}; sent ${sent} held`)
          return Response.json({ socket, sent })
        } catch (error) {
          return new Response(error instanceof Error ? error.message : String(error), { status: 400 })
        }
      }
      // Every open file, for prose pending and prose port
      if (pathname === "/docs") {
        return Response.json((await docs.all()).map((doc) => doc.file))
      }
      if (pathname === "/activity" && req.method === "GET") {
        const doc = await docFor(searchParams)
        if (doc instanceof Response) return doc
        return new Response(doc.snapshot(false), { headers: { "content-type": "application/json" } })
      }
      if ((pathname === "/comment" || pathname === "/activity") && req.method === "POST") {
        try {
          const body = await req.json()
          const input = pathname === "/comment" ? parseUser(body) : parseActivity(body)
          // An agent's reply finds its doc by the request ids it answers, so
          // prose respond works by port for any open file
          let doc = searchParams.has("file") ? await docFor(searchParams) : undefined
          if (doc instanceof Response) return doc
          if (!doc && input.kind === "activity") doc = await docs.owning(input.requestIds)
          doc ??= primary
          const { event, delivered } = input.kind === "activity"
            ? await doc.postActivity(input)
            : await doc.comment(input)
          // Delivered means the session has it; a failed post leaves it waiting
          // in the log, which the page reports as "no agent connected".
          return Response.json({ event, agentConnected: delivered })
        } catch (error) {
          if (error instanceof InputError) {
            return new Response(error.message, { status: error.status })
          }
          if (error instanceof SyntaxError) {
            return new Response("Invalid JSON", { status: 400 })
          }
          console.error("prose: could not save conversation event", error)
          return new Response(
            "Could not save message. Retry when the server is available.",
            { status: 500 },
          )
        }
      }
      return new Response("not found", { status: 404 })
    })

    const url = `http://localhost:${port}`
    console.log(`reviewing ${file} at ${url}`)
    console.log(
      session
        ? `comments go to session socket ${session.socket} (logged to ${primary.commentLog})`
        : `no session socket (set CLAUDE_CODE_MESSAGING_SOCKET or --socket); comments only logged to ${primary.commentLog}`,
    )
    if (open) {
      await bundleJs
      await new Deno.Command("open", { args: [url] }).output()
    }
  })
  .parse(Deno.args)
