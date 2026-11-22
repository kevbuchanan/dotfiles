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
import { Fleet, opt, readState, root, setState, tmux, unsetOpt } from "../fleet.ts"
import { addWorktree } from "../git.ts"
import { die, FleetError, isFile, output, print, readText, run, shq, sleep, test, warn } from "../run.ts"
import * as signal from "../signal.ts"
import {
  asPane,
  oneOf,
  ORCH_COMMANDS,
  type Pane,
  parseRole,
  type Role,
  roleSettings,
  SEAT_ROLES,
  type SeatRole,
  SETTING_PREFIX,
  type Settings,
} from "../types.ts"
import type { PairLaunch, SeatCommands, Setup } from "./agent.ts"

const env = (name: string) => Deno.env.get(name) ?? ""

export const name = "opencode"

// auto approves every request no rule denies, as opencode's --auto does; ask
// leaves opencode's default, which asks
const MODES = ["auto", "ask"] as const
type Mode = (typeof MODES)[number]

// The permission actions fleet's rules name; opencode has more
type Action = "*" | "shell" | "edit" | "external_directory"
type Rule = { action: Action; resource: string; effect: "allow" | "deny" | "ask" }

// An opencode session id, which opencode requires to start with "ses"
type SessionId = string & { readonly __session: unique symbol }
function asSessionId(value: string): SessionId {
  if (!value.startsWith("ses")) die(`not an opencode session id: ${value || "(empty)"}`)
  return value as SessionId
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// What `fleet opencode launch` reads from the state folder
type Config = {
  notes: string
  mode: Mode
  models: Record<SeatRole, string>
  efforts: Record<SeatRole, string>
}

function readConfig(file: string, notes: string): Config {
  const fallback: Config = {
    notes,
    mode: "ask",
    models: { orchestrator: "", worker: "" },
    efforts: { orchestrator: "", worker: "" },
  }
  if (!isFile(file)) return fallback
  let value: unknown
  try {
    value = JSON.parse(readText(file))
  } catch {
    die(`${file} isn't JSON; fleet new writes it`)
  }
  const roles = (field: unknown): Record<SeatRole, string> => {
    const record = isRecord(field) ? field : {}
    const at = (role: SeatRole) => typeof record[role] === "string" ? record[role] : ""
    return { orchestrator: at("orchestrator"), worker: at("worker") }
  }
  if (!isRecord(value)) return fallback
  return {
    notes: typeof value.notes === "string" ? value.notes : notes,
    mode: typeof value.mode === "string" && oneOf(MODES, value.mode) ? value.mode : "ask",
    models: roles(value.models),
    efforts: roles(value.efforts),
  }
}

export function check(settings: Settings) {
  const mode = settings.FLEET_WORKER_MODE
  if (mode && !oneOf(MODES, mode)) die(`worker mode for opencode must be auto or ask: ${mode}`)
  for (const role of SEAT_ROLES) {
    const { model, effort } = roleSettings(settings, role)
    const prefix = SETTING_PREFIX[role]
    if (model && !/^[^/\s]+\/[^#\s]+(#\S+)?$/.test(model)) {
      die(`FLEET_${prefix}_MODEL for opencode is provider/model or provider/model#variant: ${model}`)
    }
    if (effort && !model) {
      die(`FLEET_${prefix}_EFFORT for opencode is the model's variant, so it needs FLEET_${prefix}_MODEL`)
    }
  }
}

export async function prepare(s: Setup): Promise<SeatCommands> {
  const mode = s.settings.FLEET_WORKER_MODE || "auto"
  const config: Config = {
    notes: s.notes,
    mode: oneOf(MODES, mode) ? mode : "auto",
    models: { orchestrator: s.settings.FLEET_ORCH_MODEL, worker: s.settings.FLEET_WORKER_MODEL },
    efforts: { orchestrator: s.settings.FLEET_ORCH_EFFORT, worker: s.settings.FLEET_WORKER_EFFORT },
  }
  Deno.writeTextFileSync(join(s.rundir, "opencode.json"), JSON.stringify(config, null, 2) + "\n")
  await server()
  const fleet = `${shq(s.root)}/bin/fleet`
  return {
    orchestrator: (name) => `${fleet} opencode launch orchestrator ${name}`,
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
export function header(sender: string, skill: SeatRole): string {
  return `From fleet, sent by ${sender} (handle per the fleet:${skill} skill in your instructions):`
}

// The session the seat's pane runs, or empty before one starts
async function sessionIn(pane: Pane): Promise<SessionId | ""> {
  const id = await opt(pane, "@agent_session")
  return id ? asSessionId(id) : ""
}

export async function ready(pane: Pane): Promise<boolean> {
  return (await sessionIn(pane)) !== ""
}

// A queued prompt waits in the session's inbox while it works, and starts a
// turn when it is idle
export async function deliver(pane: Pane, message: string) {
  const id = (await sessionIn(pane)) || die("the seat has no opencode session")
  await queue(id, message)
}

// A fresh context is a new session: the pane runs its launch line again,
// which creates one
export async function reset(pane: Pane) {
  const cmd = await opt(pane, "@agent_cmd")
  const dir = await output("tmux", ["display", "-p", "-t", pane, "#{pane_current_path}"])
  await unsetOpt(pane, "@agent_session")
  await tmux("respawn-pane", "-k", "-t", pane, ...(dir ? ["-c", dir] : []))
  await tmux("send-keys", "-t", pane, cmd, "Enter")
}

export async function interrupt(pane: Pane) {
  const id = await sessionIn(pane)
  if (id) await api("POST", `/api/session/${id}/interrupt`)
}

// Whether the seat's session has work running in the background. A
// subagent started with background set runs as a child session, listed by
// its parentID and running while it is in session.active. A shell command
// started with background set is listed, while it runs, among its folder's
// shells with the session's id. Either way the parent's turn can end first,
// and the work's result starts its next turn.
export async function backgroundWork(pane: Pane, _record: string): Promise<boolean> {
  const id = await sessionIn(pane)
  if (!id) return false
  const children = dataOf(await api("GET", `/api/session?parentID=${encodeURIComponent(id)}`))
  if (Array.isArray(children) && children.length) {
    const active = await activeSessions()
    if (children.some((child) => isRecord(child) && typeof child.id === "string" && active.has(child.id))) {
      return true
    }
  }
  const session = dataOf(await api("GET", `/api/session/${id}`))
  const location = isRecord(session) && isRecord(session.location) ? session.location.directory : undefined
  if (typeof location !== "string") return false
  const shells = dataOf(
    await api("GET", `/api/shell?location%5Bdirectory%5D=${encodeURIComponent(location)}`),
  )
  return Array.isArray(shells) && shells.some((shell) => isRecord(shell) && sessionOf(shell.metadata) === id)
}

export function pairCommand({ root, name, prompt }: PairLaunch): string {
  return `${shq(root)}/bin/fleet opencode launch pair ${name} --prompt ${shq(prompt)}`
}

export function paneEnv(_orchCmd: string): string[] {
  return []
}

// The watcher runs in a window of its own after the shell window. It has no
// @agent_seat, so seat commands and `fleet status` skip it, and `fleet kill`
// stops it with the session.
export async function started(fleet: Fleet, dir: string) {
  const pane = asPane(
    await run("tmux", [
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
    ]),
  )
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
  let value: unknown
  try {
    value = JSON.parse(readText(serviceFile()))
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value.url !== "string" || !value.url) return null
  return { url: value.url, password: typeof value.password === "string" ? value.password : "", own: true }
}

const auth = (s: Server) => ({ authorization: `Basic ${btoa(`opencode:${s.password}`)}` })

// fetch, with a failure to reach the server as a FleetError, so callers
// tell a server that is down from a mistake in fleet
async function request(s: Server, path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${s.url}${path}`, { ...init, headers: { ...auth(s), ...init.headers } })
  } catch (e) {
    if (!(e instanceof TypeError)) throw e
    die(`can't reach opencode at ${s.url}: ${e.message}`)
  }
}

async function reachable(s: Server): Promise<boolean> {
  try {
    const r = await request(s, "/api/info")
    await r.body?.cancel()
    return r.ok
  } catch (e) {
    if (!(e instanceof FleetError)) throw e
    return false
  }
}

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

// One API call. The reply is unknown until a caller narrows it.
async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const s = await server()
  const r = await request(s, path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  if (!r.ok) die(`opencode ${method} ${path}: ${r.status} ${text.slice(0, 300)}`)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    die(`opencode ${method} ${path} answered with something other than JSON: ${text.slice(0, 300)}`)
  }
}

// The data field of an API reply
const dataOf = (reply: unknown): unknown => isRecord(reply) ? reply.data : undefined

const queue = (id: SessionId, text: string) =>
  api("POST", `/api/session/${id}/prompt`, { text, delivery: "queue" })

// Sessions running a turn now
async function activeSessions(): Promise<Set<string>> {
  const data = dataOf(await api("GET", "/api/session/active"))
  return new Set(isRecord(data) ? Object.keys(data) : [])
}

// Sessions with a permission request waiting on an answer
async function askingSessions(): Promise<Set<string>> {
  const data = dataOf(await api("GET", "/api/permission/request"))
  return new Set(Array.isArray(data) ? data.map(sessionOf).filter(Boolean) : [])
}

// --- fleet opencode launch ---

// Every seat may edit the notes. A worker may report, the orchestrator may
// run seat commands, and in mode auto a worker's other requests are approved.
function rules(role: Role, config: Config): Rule[] {
  const notes = `${config.notes}/*`
  const out: Rule[] = []
  if (role === "worker" && config.mode === "auto") out.push({ action: "*", resource: "*", effect: "allow" })
  out.push(
    { action: "external_directory", resource: notes, effect: "allow" },
    { action: "edit", resource: notes, effect: "allow" },
  )
  const commands: readonly string[] = role === "worker"
    ? ["report"]
    : role === "orchestrator"
    ? ORCH_COMMANDS
    : []
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
  const out: { providerID: string; id: string; variant?: string } = {
    providerID: ref.slice(0, slash),
    id: ref.slice(slash + 1),
  }
  if (variant || effort) out.variant = variant || effort
  return out
}

// fleet opencode launch <orchestrator|worker|pair> <name> [--prompt <text>]:
// runs in the pane, creates the session and runs opencode's interface on it.
// When the interface exits, the session has ended.
async function launch(args: string[]) {
  const usage = "usage: fleet opencode launch <orchestrator|worker|pair> <name> [--prompt <text>]"
  const role = parseRole(args[0] || die(usage))
  const name = args[1] || die(usage)
  const prompt = args[2] === "--prompt" ? args[3] ?? "" : ""
  const pane = asPane(env("TMUX_PANE") || die("fleet opencode launch runs in a fleet pane"))
  const fleet = await Fleet.current()
  const config = readConfig(join(fleet.rundir, "opencode.json"), fleet.notes)
  const id = asSessionId(`ses-fleet-${name}-${Date.now().toString(36)}`)
  const dir = Deno.cwd()
  await api("POST", "/api/session", {
    id,
    title: name,
    location: { directory: dir },
    permissions: rules(role, config),
    model: role === "pair" ? undefined : modelRef(config.models[role], config.efforts[role]),
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
  await signal.started(pane, { session: id })
  if (prompt) await queue(id, prompt)

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

// The session id anywhere in an event's data. opencode's event payloads put
// it at different depths, so this searches rather than naming one path.
function sessionOf(value: unknown): string {
  if (typeof value !== "object" || value === null) return ""
  for (const [k, v] of Object.entries(value)) {
    if (k === "sessionID" && typeof v === "string") return v
    const found = sessionOf(v)
    if (found) return found
  }
  return ""
}

// The events the watcher acts on, and what each does to the seat
const STOPS = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.execution.cancelled",
] as const
const WATCHED = ["session.execution.started", "permission.asked", "permission.replied", ...STOPS] as const
type Watched = (typeof WATCHED)[number]

// fleet opencode watch: follows the server's events for the fleet's seats.
// A turn that starts makes the seat busy, a permission request makes it
// waiting, and a turn that ends is a stop: fleet runs the todo check, and
// when it answers, the answer goes to the session as a queued prompt. The
// stream drops events while it is down, so each connection first reads
// which sessions are running or waiting.
async function watch(fleet: Fleet) {
  // the panes whose last stop fleet answered, so their next stop is a second one
  const answered = new Set<Pane>()
  const panes = async () => {
    const out = await output("tmux", [
      "list-panes",
      "-s",
      "-t",
      fleet.target,
      "-F",
      "#{pane_id}\t#{@agent_session}",
    ])
    const map = new Map<string, Pane>()
    for (const line of out.split("\n")) {
      const [pane, id] = line.split("\t")
      if (pane && id) map.set(id, asPane(pane))
    }
    return map
  }
  const stop = async (pane: Pane) => {
    const again = answered.delete(pane)
    const reply = await signal.stopped(fleet, pane, again, () => backgroundWork(pane, ""))
    if (reply) {
      answered.add(pane)
      await deliver(pane, reply)
    }
  }
  const actions: Record<Watched, (pane: Pane) => Promise<void>> = {
    "session.execution.started": (pane) => setState(pane, "busy"),
    "permission.asked": (pane) => setState(pane, "waiting"),
    "permission.replied": (pane) => setState(pane, "busy"),
    "session.execution.succeeded": stop,
    "session.execution.failed": stop,
    "session.execution.interrupted": stop,
    "session.execution.cancelled": stop,
  }
  const reconcile = async () => {
    const active = await activeSessions()
    const asking = await askingSessions()
    for (const [id, pane] of await panes()) {
      const state = await readState(pane)
      if (asking.has(id)) await setState(pane, "waiting")
      else if (active.has(id)) await setState(pane, "busy")
      else if (state === "busy" || state === "waiting") await stop(pane)
    }
  }
  const handle = async (event: unknown) => {
    if (!isRecord(event) || typeof event.type !== "string" || !oneOf(WATCHED, event.type)) return
    const pane = (await panes()).get(sessionOf(event.data))
    if (pane) await actions[event.type](pane)
  }

  for (;;) {
    try {
      const s = await server()
      const r = await request(s, "/api/event")
      if (!r.ok || !r.body) die(`opencode events: ${r.status}`)
      print(`watching ${fleet.name}'s seats on ${s.url}`)
      await reconcile()
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ""
      for (;;) {
        const chunk = await readFrom(reader, s)
        if (chunk === null) break
        buffer += chunk
        let end
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())
            .join("")
          if (!data) continue
          let event: unknown
          try {
            event = JSON.parse(data)
          } catch {
            warn(`skipped an event that isn't JSON: ${data.slice(0, 200)}`)
            continue
          }
          try {
            await handle(event)
          } catch (e) {
            // a seat that went away mid-event; the stream goes on
            if (!(e instanceof FleetError)) throw e
            warn(e.message)
          }
        }
      }
      warn("the event stream ended; reconnecting")
    } catch (e) {
      if (!(e instanceof FleetError)) throw e
      warn(`${e.message}; reconnecting`)
      cached = null
    }
    if (!(await test("tmux", ["has-session", "-t", fleet.target]))) return
    await sleep(1000)
  }
}

// The next chunk of the event stream, or null at its end. A dropped
// connection is a FleetError, like any other trouble reaching the server.
async function readFrom(reader: ReadableStreamDefaultReader<string>, s: Server): Promise<string | null> {
  try {
    const { value, done } = await reader.read()
    return done ? null : value
  } catch (e) {
    if (!(e instanceof TypeError) && !(e instanceof DOMException)) throw e
    die(`lost opencode's event stream at ${s.url}: ${e.message}`)
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
