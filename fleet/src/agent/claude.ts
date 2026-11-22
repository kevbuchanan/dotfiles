// What fleet needs from Claude Code that another agent would do its own way.

import { dirname, join, resolve } from "@std/path"
import { postToSession } from "../../../lib/claude/session.ts"
import { type Fleet, opt, tmux } from "../fleet.ts"
import { addWorktree } from "../git.ts"
import {
  die,
  fill,
  isFile,
  isSocket,
  output,
  print,
  readText,
  realPath,
  run,
  shq,
  test,
  tilde,
  warn,
} from "../run.ts"
import {
  oneOf,
  ORCH_COMMANDS,
  type Pane,
  roleSettings,
  type SeatRole,
  SETTING_PREFIX,
  type Settings,
} from "../types.ts"
import type { PairLaunch, SeatCommands, Setup } from "./agent.ts"

// The agent's name, for pane titles
export const name = "claude"

const env = (name: string) => Deno.env.get(name) ?? ""

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// The command of the first command hook in a settings file's WorktreeCreate
// groups, or empty when the file has none. A file in another shape has none.
function hookIn(settings: unknown): string {
  const groups = isRecord(settings) && isRecord(settings.hooks) ? settings.hooks.WorktreeCreate : undefined
  if (!Array.isArray(groups)) return ""
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue
    for (const hook of group.hooks) {
      if (isRecord(hook) && hook.type === "command" && typeof hook.command === "string" && hook.command) {
        return hook.command
      }
    }
  }
  return ""
}

// The WorktreeCreate hook command Claude Code would run for a repo: the
// repo's local settings, then its shared settings, then the user's, as
// Claude Code reads them
function worktreeHook(repo: string): string {
  const configDir = env("CLAUDE_CONFIG_DIR") || join(env("HOME"), ".claude")
  const files = [
    join(repo, ".claude", "settings.local.json"),
    join(repo, ".claude", "settings.json"),
    join(configDir, "settings.json"),
  ]
  for (const file of files) {
    if (!isFile(file)) continue
    let settings: unknown
    try {
      settings = JSON.parse(Deno.readTextFileSync(file))
    } catch {
      continue
    }
    const hook = hookIn(settings)
    if (hook) return hook
  }
  return ""
}

// Creates the worktree <repo>/.claude/worktrees/<name> the way `claude -w
// <name>` would: through the repo's WorktreeCreate hook when it has one, so
// a hook that provisions dependencies still runs, and otherwise on a new
// branch worktree-<name> from the repo's default branch. Returns the branch
// the worktree is on, since a hook picks its own branch name.
export async function createWorktree(repo: string, name: string): Promise<string> {
  const wt = join(repo, ".claude", "worktrees", name)
  const hook = worktreeHook(repo)
  if (hook) {
    const input = JSON.stringify({ hook_event_name: "WorktreeCreate", name, cwd: repo })
    const out = await run("sh", ["-c", hook], {
      cwd: repo,
      stdin: input,
      env: { CLAUDE_PROJECT_DIR: repo },
      quiet: false,
    })
    const printed = out.split("\n").filter(Boolean).at(-1) ?? ""
    if (isWorktreeAt(printed, wt)) return await branchOf(wt)
    die(`${repo}'s WorktreeCreate hook printed ${printed || "nothing"}; fleet needs the worktree at ${wt}`)
  }
  return await addWorktree(repo, name)
}

function isWorktreeAt(printed: string, wt: string): boolean {
  try {
    return Deno.realPathSync(printed) === Deno.realPathSync(wt)
  } catch {
    return false
  }
}

// The branch a hook's worktree is on. fleet puts a worktree back on its
// seat's branch between tasks, so a detached one has nothing to go back to.
async function branchOf(wt: string): Promise<string> {
  const branch = await output("git", ["-C", wt, "symbolic-ref", "-q", "--short", "HEAD"])
  if (!branch) die(`the WorktreeCreate hook left ${wt} on a detached HEAD; fleet needs it on a branch`)
  return branch
}

// Claude Code's permission modes, for --worker-mode
const MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"] as const
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

// Refuses a fleet's settings that Claude Code can't run with: the worker
// mode, and each role's effort
export function check(settings: Settings) {
  const mode = settings.FLEET_WORKER_MODE
  if (mode && !oneOf(MODES, mode)) {
    die(`worker mode must be acceptEdits, auto, bypassPermissions, manual, dontAsk or plan: ${mode}`)
  }
  roleFlags("orchestrator", settings)
  roleFlags("worker", settings)
}

// Renders the settings each role's sessions run with, trusts the notes
// folder, and returns each role's launch command
export async function prepare(s: Setup): Promise<SeatCommands> {
  const mode = s.settings.FLEET_WORKER_MODE || "auto"
  const orchFlags = roleFlags("orchestrator", s.settings)
  const workerFlags = roleFlags("worker", s.settings)

  // every seat may edit the notes; the orchestrator may also run seat commands
  const edit = `Edit(/${s.notes}/**)`
  const settingsText = fill(readText(join(s.root, "settings.json")), { ROOT: s.root })
  Deno.writeTextFileSync(join(s.rundir, "settings.json"), settingsText)
  const base = JSON.parse(settingsText)
  const withAllow = (allow: string[]) =>
    JSON.stringify({ ...base, permissions: { ...base.permissions, allow } }, null, 2) + "\n"
  Deno.writeTextFileSync(join(s.rundir, "worker-settings.json"), withAllow([edit, "Bash(fleet report *)"]))
  Deno.writeTextFileSync(
    join(s.rundir, "orch-settings.json"),
    withAllow([edit, ...ORCH_COMMANDS.flatMap((c) => [`Bash(fleet ${c})`, `Bash(fleet ${c} *)`])]),
  )

  // the plugin carries the fleet:orchestrator and fleet:worker skills, which
  // hold the protocol; seats read a skill when they use it, so edits reach
  // running seats. Seats get --add-dir for the fleet's other repos, so a
  // worker can edit its worktree there.
  let claude = `claude --add-dir ${shq(s.notes)}${
    s.others.map((r) => ` --add-dir ${shq(r)}`).join("")
  } --plugin-dir ${shq(s.root)}/plugin`
  // Sessions find each other only within one config dir, so every seat gets
  // the same one. It is part of each pane's @agent_cmd, so restart keeps it.
  if (env("CLAUDE_CONFIG_DIR")) {
    claude = `CLAUDE_CONFIG_DIR=${shq(realPath(resolve(env("CLAUDE_CONFIG_DIR"))))} ${claude}`
  }
  await checkTrust(s.notes, s.others)
  const rundir = shq(s.rundir)
  return {
    orchestrator: (name) =>
      `${claude} -n ${name} --settings ${rundir}/orch-settings.json --append-system-prompt-file ${rundir}/${name}.md${orchFlags}`,
    worker: (name) =>
      `${claude} -n ${name} --settings ${rundir}/worker-settings.json --append-system-prompt-file ${rundir}/${name}.md --permission-mode ${mode}${workerFlags}`,
  }
}

// --model and --effort for one role from FLEET_<role>_MODEL and _EFFORT. They
// become part of each seat's launch line, so `restart` keeps them.
function roleFlags(role: SeatRole, settings: Settings): string {
  const { model, effort } = roleSettings(settings, role)
  let flags = ""
  if (model) flags += ` --model ${shq(model)}`
  if (effort) {
    if (!oneOf(EFFORTS, effort)) {
      die(`FLEET_${SETTING_PREFIX[role]}_EFFORT must be low, medium, high, xhigh or max: ${effort}`)
    }
    flags += ` --effort ${effort}`
  }
  return flags
}

// Claude Code asks each session to trust every --add-dir folder it doesn't
// trust yet, and that answer lasts one session, so an untrusted notes folder
// stops every seat at a prompt. Trust given when starting claude in a folder
// is saved in the config's .claude.json as projects[<path>].hasTrustDialogAccepted.
// A folder is trusted when it or a parent has that flag, but inside a git repo
// Claude Code looks no higher than the repo's root, and each notes folder is a
// repo of its own. FLEET_CLAUDE_JSON names another file, for tests.
function claudeJson(): string {
  const configDir = env("CLAUDE_CONFIG_DIR")
  return env("FLEET_CLAUDE_JSON") ||
    (configDir ? join(resolve(configDir), ".claude.json") : join(env("HOME"), ".claude.json"))
}

type Projects = Record<string, { hasTrustDialogAccepted?: boolean }>

function readProjects(): Projects | null {
  let config: unknown
  try {
    config = JSON.parse(Deno.readTextFileSync(claudeJson()))
  } catch {
    return null
  }
  if (!isRecord(config)) return null
  const projects = config.projects ?? {}
  if (!isRecord(projects)) return null
  const out: Projects = {}
  for (const [dir, project] of Object.entries(projects)) {
    out[dir] = { hasTrustDialogAccepted: isRecord(project) && project.hasTrustDialogAccepted === true }
  }
  return out
}

async function untrusted(projects: Projects, dirs: string[]): Promise<string[]> {
  const covered = async (dir: string) => {
    const top = (await test("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]))
      ? realPath(await run("git", ["-C", dir, "rev-parse", "--show-toplevel"]))
      : ""
    for (let d = realPath(dir);; d = dirname(d)) {
      if (projects[d]?.hasTrustDialogAccepted) return true
      if (d === top || d === dirname(d)) return false
    }
  }
  const missing = []
  for (const d of dirs) if (!(await covered(d))) missing.push(d)
  return missing
}

// fleet made the notes folder, so it trusts it the way the trust prompt
// would. Running sessions rewrite .claude.json by reading it, changing one
// key and renaming a temporary file over it; this does the same, so the
// entry is lost only if another session's write lands between this read and
// this rename, and then the seats prompt again. The fields besides
// hasTrustDialogAccepted are Claude Code's defaults for a new project.
function trust(dir: string) {
  const file = claudeJson()
  const config: unknown = JSON.parse(Deno.readTextFileSync(file))
  if (!isRecord(config)) die(`${file} isn't a JSON object, so fleet can't add the notes folder to it`)
  const projects = isRecord(config.projects) ? config.projects : {}
  const existing = projects[dir]
  config.projects = projects
  projects[dir] = {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
    ...(isRecord(existing) ? existing : {}),
    hasTrustDialogAccepted: true,
  }
  const tmp = `${file}.fleet-${Deno.pid}`
  Deno.writeTextFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 })
  Deno.renameSync(tmp, file)
  print(`trusted ${tilde(dir)} in ${tilde(file)}`)
}

async function checkTrust(notes: string, repos: string[]) {
  const projects = readProjects()
  // no readable config: Claude Code's own prompt is the check
  if (!projects) return
  if ((await untrusted(projects, [notes])).length) trust(realPath(notes))
  const missing = await untrusted(projects, repos)
  if (!missing.length) return
  const config = env("CLAUDE_CONFIG_DIR") ? `CLAUDE_CONFIG_DIR=${shq(env("CLAUDE_CONFIG_DIR"))} ` : ""
  warn(
    `Claude Code doesn't trust ${missing.map(tilde).join(" or ")}, so every seat will stop to ask.\n` +
      `Start claude there once and choose "Yes, trust it" to trust it for good:\n` +
      missing.map((d) => `  cd ${shq(d)} && ${config}claude\n`).join(""),
  )
  if (Deno.stdin.isTerminal() && !confirm("Start the fleet anyway?")) Deno.exit(1)
}

// Claude Code needs nothing beside its seats: its hooks report their state
export async function started(_fleet: Fleet, _dir: string) {}

// A seat's launch line with one more folder its session may edit
export function addDir(cmd: string, path: string): string {
  return cmd.replace(/(^|\s)claude --add-dir /, `$1claude --add-dir ${shq(path)} --add-dir `)
}

// The header fleet puts on every message, which names the skill that
// handles it, so a session reads that skill for it
export function header(sender: string, skill: SeatRole): string {
  return `From fleet, sent by ${sender} (handle per /fleet:${skill} skill):`
}

// Whether the session in pane can take a message: its register hook has
// recorded its inbox socket
export async function ready(pane: Pane): Promise<boolean> {
  return isSocket(await opt(pane, "@agent_socket"))
}

// Writes a message to the session's inbox socket. Claude Code wakes an idle
// session with it, and a busy one reads it between tool calls.
export async function deliver(pane: Pane, message: string) {
  const socket = await opt(pane, "@agent_socket")
  try {
    await postToSession({ socket }, message)
  } catch (e) {
    die(`the inbox socket ${socket} refused it: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// Starts the session in pane on a fresh context. Claude Code runs its
// SessionStart hooks again, so the seat registers again.
export async function reset(pane: Pane) {
  await tmux("send-keys", "-t", pane, "-l", "/clear")
  await tmux("send-keys", "-t", pane, "Enter")
}

// Stops the session's current turn
export async function interrupt(pane: Pane) {
  await tmux("send-keys", "-t", pane, "Escape")
}

// The command a pairing window's agent pane runs. --add-dir takes any number
// of folders, so -- ends the options and keeps the prompt from being read as
// one.
export function pairCommand({ root, name, notes, prompt }: PairLaunch): string {
  return `claude -n ${name} --plugin-dir ${shq(root)}/plugin --add-dir ${shq(notes)} -- ${shq(prompt)}`
}

// The environment a fleet's seats run with, from the orchestrator's launch
// line, for panes fleet opens later, such as a pairing window: a claude
// started there by hand then gets the fleet's config folder too
export function paneEnv(orchCmd: string): string[] {
  const configDir = orchCmd.match(/^CLAUDE_CONFIG_DIR=('(?:[^']|'\\'')*'|\S+) claude /)?.[1]
  return configDir ? ["-e", `CLAUDE_CONFIG_DIR=${unquote(configDir)}`] : []
}

// A value shq quoted, as it was typed into a launch line
function unquote(value: string): string {
  return value.startsWith("'") ? value.slice(1, -1).replaceAll(`'\\''`, "'") : value
}
