// opencode as the agent in fleet's seats. opencode v2 keeps every session in
// one server, the background service, and its interfaces are clients of it,
// so fleet drives a seat through the server's HTTP API by session id:
//
// - A seat's pane runs `fleet opencode launch`, which creates a session with
//   an id fleet picks, the role's permissions and model, the pane's
//   environment for its shell commands, and the seat's prompt and its role's
//   skill as the session's instructions. It records the id on the pane,
//   signals start, and runs opencode's interface on that session.
// - Messages are queued prompts, which wait while the session is busy.
// - `fleet opencode watch`, in the fleet's watch window, follows the
//   server's event stream and reports each seat's state with fleet signal,
//   the way Claude Code's hooks do.
//
// FLEET_OPENCODE_URL and FLEET_OPENCODE_PASSWORD name another server, such
// as a private one for tests. Otherwise fleet reads the background service's
// address from opencode's state folder and starts the service when it isn't
// running.

import { join } from "@std/path"
import { Fleet, opt, root, tmux } from "../fleet.ts"
import { addWorktree } from "../git.ts"
import { die, FleetError, isFile, output, print, readText, run, shq, sleep, test, warn } from "../run.ts"
import * as signal from "../signal.ts"
import type { SeatCommands, Setup } from "./claude.ts"

const env = (name: string) => Deno.env.get(name) ?? ""

export const name = "opencode"

// auto approves every request no rule denies, as opencode's --auto does; ask
// leaves opencode's default, which asks
const MODES = ["auto", "ask"]

type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

// What `fleet opencode launch` reads from the state folder for each role
type Config = { notes: string; mode: string; models: Record<string, string>; efforts: Record<string, string> }

export function check(settings: Record<string, string>) {
  const mode = settings.FLEET_WORKER_MODE
  if (mode && !MODES.includes(mode)) die(`worker mode for opencode must be auto or ask: ${mode}`)
  for (const role of ["ORCH", "WORKER"]) {
    const model = settings[`FLEET_${role}_MODEL`] ?? ""
    if (model && !/^[^/\s]+\/[^#\s]+(#\S+)?$/.test(model)) {
      die(`FLEET_${role}_MODEL for opencode is provider/model or provider/model#variant: ${model}`)
    }
    if (settings[`FLEET_${role}_EFFORT`] && !model) {
      die(`FLEET_${role}_EFFORT for opencode is the model's variant, so it needs FLEET_${role}_MODEL`)
    }
  }
}

export async function prepare(s: Setup): Promise<SeatCommands> {
  const config: Config = {
    notes: s.notes,
    mode: s.settings.FLEET_WORKER_MODE || "auto",
    models: { orch: s.settings.FLEET_ORCH_MODEL ?? "", worker: s.settings.FLEET_WORKER_MODEL ?? "" },
    efforts: { orch: s.settings.FLEET_ORCH_EFFORT ?? "", worker: s.settings.FLEET_WORKER_EFFORT ?? "" },
  }
  Deno.writeTextFileSync(join(s.rundir, "opencode.json"), JSON.stringify(config, null, 2) + "\n")
  await server()
  const fleet = `${shq(s.root)}/bin/fleet`
  return {
    orch: (name) => `${fleet} opencode launch orchestrator ${name}`,
    worker: (name) => `${fleet} opencode launch worker ${name}`,
  }
}

// opencode asks for no folder up front: a session may reach folders outside
// its own unless a rule says otherwise
export function addDir(cmd: string, _path: string): string {
  return cmd
}

// opencode has no worktree hook, so fleet adds a plain one
export async function createWorktree(repo: string, name: string): Promise<string> {
  return await addWorktree(repo, name)
}

// The seat's instructions hold its role's skill, so the header names it
export function header(sender: string, skill: string): string {
  return `From fleet, sent by ${sender} (handle per the fleet:${skill} skill in your instructions):`
}

export async function ready(pane: string): Promise<boolean> {
  return (await opt(pane, "@agent_session")) !== ""
}

// A queued prompt waits in the session's inbox while it works, and starts a
// turn when it is idle
export async function deliver(pane: string, message: string) {
  const id = (await opt(pane, "@agent_session")) || die("the seat has no opencode session")
  await api("POST", `/api/session/${id}/prompt`, { text: message, delivery: "queue" })
}

// A fresh context is a new session: the pane runs its launch line again,
// which creates one
export async function reset(pane: string) {
  const cmd = await opt(pane, "@agent_cmd")
  const dir = await output("tmux", ["display", "-p", "-t", pane, "#{pane_current_path}"])
  await tmux("set", "-p", "-u", "-t", pane, "@agent_session")
  await tmux("respawn-pane", "-k", "-t", pane, ...(dir ? ["-c", dir] : []))
  await tmux("send-keys", "-t", pane, cmd, "Enter")
}

export async function interrupt(pane: string) {
  const id = await opt(pane, "@agent_session")
  if (id) await api("POST", `/api/session/${id}/interrupt`)
}

export function pairCommand(root: string, name: string, _notes: string, prompt: string): string {
  return `${shq(root)}/bin/fleet opencode launch pair ${name} --prompt ${shq(prompt)}`
}

export function paneEnv(_orchCmd: string): string[] {
  return []
}

// The watcher runs in a window of its own after the shell window. It has no
// @agent_seat, so seat commands and `fleet status` skip it, and `fleet kill`
// stops it with the session.
export async function started(fleet: Fleet, dir: string) {
  const pane = await run("tmux", [
    "new-window",
    "-d",
    "-t",
    fleet.target,
    "-n",
    "watch",
    "-c",
    dir,
    "-P",
    "-F",
    "#{pane_id}",
  ])
  await tmux("set", "-p", "-t", pane, "allow-set-title", "off")
  await tmux("select-pane", "-t", pane, "-T", `${fleet.name}-watch`)
  await tmux("send-keys", "-t", pane, `${shq(root)}/bin/fleet -s ${fleet.name} opencode watch`, "Enter")
}

// --- the server ---

type Server = { url: string; password: string; own: boolean }

function serviceFile(): string {
  return join(env("XDG_STATE_HOME") || join(env("HOME"), ".local", "state"), "opencode", "service.json")
}

function recorded(): Server | null {
  if (env("FLEET_OPENCODE_URL")) {
    return { url: env("FLEET_OPENCODE_URL"), password: env("FLEET_OPENCODE_PASSWORD"), own: false }
  }
  if (!isFile(serviceFile())) return null
  try {
    const { url, password } = JSON.parse(readText(serviceFile()))
    return url ? { url, password: password ?? "", own: true } : null
  } catch {
    return null
  }
}

async function reachable(s: Server): Promise<boolean> {
  try {
    const r = await fetch(`${s.url}/api/info`, { headers: auth(s) })
    await r.body?.cancel()
    return r.ok
  } catch {
    return false
  }
}

const auth = (s: Server) => ({ authorization: `Basic ${btoa(`opencode:${s.password}`)}` })

let cached: Server | null = null

// The server fleet talks to, starting opencode's background service when it
// isn't running
async function server(): Promise<Server> {
  if (cached) return cached
  let s = recorded()
  if (s && (await reachable(s))) return cached = s
  if (s && !s.own) die(`no opencode server answers at ${s.url}`)
  await run("opencode", ["service", "start"], { quiet: false })
  for (let tries = 0; tries < 50; tries++) {
    s = recorded()
    if (s && (await reachable(s))) return cached = s
    await sleep(200)
  }
  die("opencode's background service did not start; run opencode service status")
}

async function api(method: string, path: string, body?: unknown) {
  const s = await server()
  const r = await fetch(`${s.url}${path}`, {
    method,
    headers: { ...auth(s), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  if (!r.ok) die(`opencode ${method} ${path}: ${r.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

// --- fleet opencode launch ---

const ORCH_COMMANDS = [
  "status",
  "task",
  "assign",
  "clear",
  "interrupt",
  "rename",
  "path",
  "diff",
  "answer",
  "bump",
  "archive",
]

// Every seat may edit the notes. A worker may report, the orchestrator may
// run seat commands, and in mode auto a worker's other requests are approved.
function rules(role: string, config: Config): Rule[] {
  const notes = `${config.notes}/*`
  const out: Rule[] = []
  if (role === "worker" && config.mode === "auto") out.push({ action: "*", resource: "*", effect: "allow" })
  out.push(
    { action: "external_directory", resource: notes, effect: "allow" },
    { action: "edit", resource: notes, effect: "allow" },
  )
  const commands = role === "worker" ? ["report"] : role === "orchestrator" ? ORCH_COMMANDS : []
  for (const c of commands) {
    out.push(
      { action: "shell", resource: `fleet ${c}`, effect: "allow" },
      { action: "shell", resource: `fleet ${c} *`, effect: "allow" },
    )
  }
  return out
}

function modelRef(model: string, effort: string) {
  if (!model) return undefined
  const [ref, variant] = model.split("#")
  const slash = ref.indexOf("/")
  const out: Record<string, string> = { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) }
  if (variant || effort) out.variant = variant || effort
  return out
}

// fleet opencode launch <orchestrator|worker|pair> <name> [--prompt <text>]:
// runs in the pane, creates the session and runs opencode's interface on it.
// When the interface exits, the session has ended.
async function launch(args: string[]) {
  const usage = "usage: fleet opencode launch <orchestrator|worker|pair> <name> [--prompt <text>]"
  const role = args[0] || die(usage)
  const name = args[1] || die(usage)
  const prompt = args[2] === "--prompt" ? args[3] ?? "" : ""
  const pane = env("TMUX_PANE") || die("fleet opencode launch runs in a fleet pane")
  const fleet = await Fleet.current()
  const configFile = join(fleet.rundir, "opencode.json")
  const config: Config = isFile(configFile)
    ? JSON.parse(readText(configFile))
    : { notes: fleet.notes, mode: "ask", models: {}, efforts: {} }
  const seatRole = role === "orchestrator" ? "orch" : role
  const id = `ses-fleet-${name}-${Date.now().toString(36)}`
  const dir = Deno.cwd()
  await api("POST", "/api/session", {
    id,
    title: name,
    location: { directory: dir },
    permissions: rules(role, config),
    model: modelRef(config.models[seatRole] ?? "", config.efforts[seatRole] ?? ""),
  })
  // the pane's environment, TMUX_PANE among it, so `fleet report` from the
  // session's shell commands finds the seat
  await api("PUT", `/api/session/${id}/environment`, { variables: Deno.env.toObject() })
  const parts = []
  const seatPrompt = join(fleet.rundir, `${name}.md`)
  if (isFile(seatPrompt)) parts.push(readText(seatPrompt))
  const skill = join(root, "plugin", "skills", role, "SKILL.md")
  if (isFile(skill)) parts.push(`The fleet:${role} skill follows.\n\n${readText(skill)}`)
  if (parts.length) {
    await api("PUT", `/api/experimental/session/${id}/instructions/entries/fleet`, {
      value: parts.join("\n\n"),
    })
  }
  await signal.started(pane, "", id)
  if (prompt) await api("POST", `/api/session/${id}/prompt`, { text: prompt, delivery: "queue" })

  const s = await server()
  const tui = new Deno.Command("opencode", {
    args: [...(s.own ? [] : ["--server", s.url]), "--session", id, dir],
    env: s.own ? {} : { OPENCODE_PASSWORD: s.password },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const { code } = await tui.output()
  await signal.ended(fleet, pane, code === 0 ? "exit" : `exit ${code}`)
}

// --- fleet opencode watch ---

// The session id anywhere in an event's data
function sessionOf(value: unknown): string {
  if (!value || typeof value !== "object") return ""
  for (const [k, v] of Object.entries(value)) {
    if (k === "sessionID" && typeof v === "string") return v
    const found = sessionOf(v)
    if (found) return found
  }
  return ""
}

const STOPS = /^session\.execution\.(succeeded|failed|interrupted|cancelled)$/

// fleet opencode watch: follows the server's events for the fleet's seats.
// A turn that starts makes the seat busy, a permission request makes it
// waiting, and a turn that ends is a stop: fleet runs the todo check, and
// when it answers, the answer goes to the session as a queued prompt. The
// stream drops events while it is down, so each connection first reads
// which sessions are running or waiting.
async function watch(fleet: Fleet) {
  // the panes whose last stop fleet answered, so their next stop is a second one
  const answered = new Set<string>()
  const panes = async () => {
    const out = await output("tmux", [
      "list-panes",
      "-s",
      "-t",
      fleet.target,
      "-F",
      "#{pane_id}\t#{@agent_session}",
    ])
    const map = new Map<string, string>()
    for (const line of out.split("\n")) {
      const [pane, id] = line.split("\t")
      if (id) map.set(id, pane)
    }
    return map
  }
  const stop = async (pane: string) => {
    const again = answered.delete(pane)
    const reply = await signal.stopped(fleet, pane, again)
    if (reply) {
      answered.add(pane)
      await deliver(pane, reply)
    }
  }
  const reconcile = async () => {
    const active = Object.keys((await api("GET", "/api/session/active"))?.data ?? {})
    const asking = new Set(((await api("GET", "/api/permission/request"))?.data ?? []).map(sessionOf))
    for (const [id, pane] of await panes()) {
      const state = await opt(pane, "@agent_state")
      if (asking.has(id)) await signal.setState(pane, "waiting")
      else if (active.includes(id)) await signal.setState(pane, "busy")
      else if (state === "busy" || state === "waiting") await stop(pane)
    }
  }
  const handle = async (event: { type?: string; data?: unknown }) => {
    const type = event.type ?? ""
    if (type !== "session.execution.started" && !type.startsWith("permission.") && !STOPS.test(type)) return
    const pane = (await panes()).get(sessionOf(event.data))
    if (!pane) return
    if (type === "session.execution.started") await signal.setState(pane, "busy")
    else if (type === "permission.asked") await signal.setState(pane, "waiting")
    else if (type === "permission.replied") await signal.setState(pane, "busy")
    else if (STOPS.test(type)) await stop(pane)
  }

  for (;;) {
    try {
      const s = await server()
      const r = await fetch(`${s.url}/api/event`, { headers: auth(s) })
      if (!r.ok || !r.body) throw new FleetError(`opencode events: ${r.status}`)
      print(`watching ${fleet.name}'s seats on ${s.url}`)
      await reconcile()
      let buffer = ""
      for await (const chunk of r.body.pipeThrough(new TextDecoderStream())) {
        buffer += chunk
        let end
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())
            .join("")
          if (!data) continue
          try {
            await handle(JSON.parse(data))
          } catch (e) {
            if (!(e instanceof FleetError) && !(e instanceof SyntaxError)) throw e
            warn(e.message)
          }
        }
      }
    } catch (e) {
      if (!(e instanceof FleetError) && !(e instanceof TypeError)) throw e
      warn(`${e.message}; reconnecting`)
      cached = null
    }
    if (!(await test("tmux", ["has-session", "-t", fleet.target]))) return
    await sleep(1000)
  }
}

// fleet opencode <launch|watch>: the commands an opencode fleet's panes run
export async function command(name: string, args: string[]) {
  switch (args[0]) {
    case "launch":
      return await launch(args.slice(1))
    case "watch":
      return await watch(await Fleet.current(name))
    default:
      die("usage: fleet opencode <launch|watch>")
  }
}
