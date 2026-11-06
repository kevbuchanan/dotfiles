// Starting, listing, stopping and removing fleets.

import { basename, join, resolve } from "@std/path"
import { Fleet, home, isFleet, opt, root, statedir, target, tmux } from "../fleet.ts"
import {
  die,
  exists,
  fill,
  isDir,
  isFile,
  output,
  passthrough,
  print,
  readRecord,
  readText,
  removeIfAny,
  run,
  shq,
  succeeds,
  test,
  warn,
  writeAtomic,
} from "../run.ts"

const env = (name: string) => Deno.env.get(name) ?? ""

// The folder as the shell named it: $PWD keeps a symlinked folder's own name,
// which a fleet takes as its default name, where Deno.cwd() resolves it
function logicalCwd(): string {
  const pwd = env("PWD")
  return pwd && realPath(pwd) === realPath(Deno.cwd()) ? pwd : Deno.cwd()
}

// an absolute path with symlinks resolved, or as given when it doesn't exist
function realPath(path: string): string {
  try {
    return Deno.realPathSync(path)
  } catch {
    return path
  }
}

export async function attach(name: string) {
  if (env("TMUX")) await tmux("switch-client", "-t", `=${name}:orch`)
  else {
    const code = await passthrough("tmux", ["attach", "-t", `=${name}:orch`])
    if (code !== 0) Deno.exit(code)
  }
}

// pane borders show the seat name and the @agent_state the hooks set
export async function borders(window: string) {
  await tmux("set", "-w", "-t", window, "pane-border-status", "top")
  await tmux("set", "-w", "-t", window, "pane-border-format", " #{pane_title} #{@agent_state} ")
}

// The command typed into a seat's pane. A worker in a git fleet gets `-w` the
// first time, which has Claude Code create its worktree. Once the worktree
// exists, the worker starts inside it instead: a repo's WorktreeCreate hook may
// refuse a name that already exists, and `fleet new` on an earlier fleet's
// name or `fleet restart` would otherwise ask for it again. @agent_cmd holds
// the line without `-w`; lines saved by older versions end in it, so it's
// dropped.
export async function launchLine(fleet: Fleet, pane: string): Promise<string> {
  const seat = await opt(pane, "@agent_seat")
  let cmd = await opt(pane, "@agent_cmd")
  const suffix = ` -w ${fleet.name}-${seat}`
  if (cmd.endsWith(suffix)) cmd = cmd.slice(0, -suffix.length)
  const repo = fleet.repo
  if (!/^w\d+$/.test(seat) || !repo) return cmd
  const wt = join(repo, ".claude", "worktrees", `${fleet.name}-${seat}`)
  // a repo that moved or went away lists nothing, so the seat asks for -w
  // again and Claude Code reports the problem in the pane
  const list = await output("git", ["-C", repo, "worktree", "list", "--porcelain"])
  if (list.split("\n").includes(`worktree ${wt}`)) return `cd ${shq(wt)} && ${cmd}`
  return `${cmd}${suffix}`
}

// Claude's own terminal-title updates would overwrite the pane title, so each
// pane keeps the title set here. @agent_cmd is what `restart` relaunches.
async function launch(fleet: Fleet, pane: string, seat: string, line: string) {
  await tmux("set", "-p", "-t", pane, "@agent_seat", seat)
  await tmux("set", "-p", "-t", pane, "@agent_cmd", line)
  await tmux("set", "-p", "-t", pane, "allow-set-title", "off")
  await tmux("select-pane", "-t", pane, "-T", `${fleet.name}-${seat}`)
  await tmux("send-keys", "-t", pane, await launchLine(fleet, pane), "Enter")
}

// --model and --effort for one role from FLEET_<role>_MODEL and _EFFORT. They
// become part of each seat's launch line, so `restart` keeps them.
function roleFlags(role: string, settings: Record<string, string>): string {
  const model = settings[`FLEET_${role}_MODEL`] ?? ""
  const effort = settings[`FLEET_${role}_EFFORT`] ?? ""
  let flags = ""
  if (model) flags += ` --model ${shq(model)}`
  if (effort) {
    if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) {
      die(`FLEET_${role}_EFFORT must be low, medium, high, xhigh or max: ${effort}`)
    }
    flags += ` --effort ${effort}`
  }
  return flags
}

// Creates the fleet-level files beside tasks/ from templates/, leaving any
// that exist as they are, and commits what it adds.
async function fleetFiles(fleet: Fleet) {
  Deno.mkdirSync(join(fleet.notes, "knowledge"), { recursive: true })
  Deno.mkdirSync(join(fleet.notes, "guidance"), { recursive: true })
  let added = false
  for (const f of ["brief.md", "backlog.md", "decisions.md", "knowledge/index.md"]) {
    const dest = join(fleet.notes, f)
    if (exists(dest)) continue
    writeAtomic(dest, fill(readText(join(root, "templates", f)), { SESSION: fleet.name }))
    added = true
  }
  if (added) await fleet.commit(`fleet ${fleet.name}: brief, backlog, decisions and knowledge`)
}

const NEW_FLAGS: Record<string, string> = {
  "--workers": "FLEET_WORKERS",
  "--worker-mode": "FLEET_WORKER_MODE",
  "--orch-model": "FLEET_ORCH_MODEL",
  "--worker-model": "FLEET_WORKER_MODEL",
  "--orch-effort": "FLEET_ORCH_EFFORT",
  "--worker-effort": "FLEET_WORKER_EFFORT",
}
const MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]

export async function create(args: string[]) {
  // Each flag sets the environment variable of the same setting for this
  // fleet, so flags win and the variables remain the fallback.
  const settings: Record<string, string> = {}
  for (const name of Object.values(NEW_FLAGS)) settings[name] = env(name)
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    let flag = arg
    let value: string
    if (arg.includes("=")) {
      flag = arg.slice(0, arg.indexOf("="))
      value = arg.slice(arg.indexOf("=") + 1)
    } else {
      if (i + 1 >= args.length) die(`${flag} needs a value`)
      value = args[++i]
    }
    const name = NEW_FLAGS[flag]
    if (!name) die(`unknown option ${flag}; see fleet help`)
    settings[name] = value
  }
  const workers = settings.FLEET_WORKERS
  if (workers && !(/^[0-9]+$/.test(workers) && Number(workers) >= 1)) {
    die(`workers must be a whole number from 1: ${workers}`)
  }
  const workerMode = settings.FLEET_WORKER_MODE
  if (workerMode && !MODES.includes(workerMode)) {
    die(`worker mode must be acceptEdits, auto, bypassPermissions, manual, dontAsk or plan: ${workerMode}`)
  }

  const name = (positional[0] || basename(logicalCwd())).replaceAll(/[.:]/g, "-")
  // the name becomes a tmux session, a notes folder and a state folder, so a
  // path would nest folders under the notes root
  if (!/^[A-Za-z0-9_-]+$/.test(name)) die(`fleet names use letters, digits, - and _: ${name}`)
  const dir = realPath(resolve(positional[1] || logicalCwd()))
  if (await test("tmux", ["has-session", "-t", target(name)])) {
    if (!(await isFleet(name))) die(`${name} is a tmux session but not a fleet`)
    // a fleet started before the fleet-level files existed gets them here
    const fleet = await Fleet.current(name)
    if (isDir(join(fleet.notes, ".git"))) await fleetFiles(fleet)
    await attach(name)
    return
  }

  const count = Number(workers || 6)
  const mode = workerMode || "auto"
  const orchFlags = roleFlags("ORCH", settings)
  const workerFlags = roleFlags("WORKER", settings)
  const notes = join(home, name)
  const fleet = Fleet.at(name, notes)
  const rundir = fleet.rundir
  const orch = `${name}-orch`
  Deno.mkdirSync(rundir, { recursive: true })
  Deno.mkdirSync(join(notes, "tasks"), { recursive: true })
  Deno.writeTextFileSync(join(rundir, "notes"), `${notes}\n`)
  if (!isDir(join(notes, ".git"))) {
    await run("git", ["-C", notes, "init", "-q"])
    await run("git", ["-C", notes, "commit", "-q", "--allow-empty", "-m", `fleet ${name}`])
  }
  await fleetFiles(fleet)

  const workerNames = Array.from({ length: count }, (_, i) => `${name}-w${i + 1}`)
  const render = (prompt: string, seat: string) => {
    const text = fill(readText(join(root, "prompts", prompt)), {
      NAME: seat,
      SESSION: name,
      ORCHESTRATOR: orch,
      WORKERS: workerNames.join(", "),
      COUNT: String(count),
      NOTES: notes,
    })
    Deno.writeTextFileSync(join(rundir, `${seat}.md`), text)
  }

  // every seat may edit the notes; the orchestrator may also run seat commands
  const edit = `Edit(/${notes}/**)`
  const settingsText = fill(readText(join(root, "settings.json")), { ROOT: root })
  Deno.writeTextFileSync(join(rundir, "settings.json"), settingsText)
  const base = JSON.parse(settingsText)
  const withAllow = (allow: string[]) =>
    JSON.stringify({ ...base, permissions: { ...base.permissions, allow } }, null, 2) + "\n"
  Deno.writeTextFileSync(join(rundir, "worker-settings.json"), withAllow([edit, "Bash(fleet report *)"]))
  const orchCommands = [
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
  Deno.writeTextFileSync(
    join(rundir, "orch-settings.json"),
    withAllow([edit, ...orchCommands.flatMap((c) => [`Bash(fleet ${c})`, `Bash(fleet ${c} *)`])]),
  )

  // the plugin carries the fleet:orchestrator and fleet:worker skills, which
  // hold the protocol; seats read a skill when they use it, so edits reach
  // running seats
  let claude = `claude --add-dir ${shq(notes)} --plugin-dir ${shq(root)}/plugin`
  // Sessions find each other only within one config dir, so every seat gets
  // the same one. It is part of each pane's @agent_cmd, so restart keeps it.
  if (env("CLAUDE_CONFIG_DIR")) {
    claude = `CLAUDE_CONFIG_DIR=${shq(realPath(resolve(env("CLAUDE_CONFIG_DIR"))))} ${claude}`
  }
  // If this call starts the tmux server, the server's environment would carry
  // CLAUDE_CONFIG_DIR into every later pane, fleet or not
  const pane = await run("tmux", [
    "new-session",
    "-d",
    "-s",
    name,
    "-n",
    "orch",
    "-c",
    dir,
    "-P",
    "-F",
    "#{pane_id}",
  ], {
    unset: ["CLAUDE_CONFIG_DIR"],
  })
  await tmux("set", "-t", target(name), "@fleet", "1")
  await tmux("set", "-t", target(name), "@fleet_notes", notes)
  await borders(`=${name}:orch`)
  render("orchestrator.md", orch)
  await launch(
    fleet,
    pane,
    "orch",
    `${claude} -n ${orch} --settings ${shq(rundir)}/orch-settings.json --append-system-prompt-file ${
      shq(rundir)
    }/${orch}.md${orchFlags}`,
  )

  // nvim on the notes folder, left of the orchestrator. It has no @agent_seat,
  // so seat commands and `fleet status` skip it.
  const editor = await run("tmux", [
    "split-window",
    "-hb",
    "-d",
    "-t",
    pane,
    "-c",
    notes,
    "-P",
    "-F",
    "#{pane_id}",
  ])
  await tmux("set", "-p", "-t", editor, "allow-set-title", "off")
  await tmux("select-pane", "-t", editor, "-T", `${name}-notes`)
  await tmux("send-keys", "-t", editor, "nvim .", "Enter")

  const panes = [
    await run("tmux", [
      "new-window",
      "-d",
      "-t",
      target(name),
      "-n",
      "workers",
      "-c",
      dir,
      "-P",
      "-F",
      "#{pane_id}",
    ]),
  ]
  for (let i = 2; i <= count; i++) {
    panes.push(
      await run("tmux", ["split-window", "-d", "-t", panes.at(-1)!, "-c", dir, "-P", "-F", "#{pane_id}"]),
    )
    await run("tmux", ["select-layout", "-t", `=${name}:workers`, "tiled"])
  }
  await borders(`=${name}:workers`)

  // a plain shell in the project folder, after the workers. It has no
  // @agent_seat, so seat commands and `fleet status` skip it.
  const shell = await run("tmux", [
    "new-window",
    "-d",
    "-t",
    target(name),
    "-n",
    "shell",
    "-c",
    dir,
    "-P",
    "-F",
    "#{pane_id}",
  ])
  await borders(`=${name}:shell`)
  await tmux("set", "-p", "-t", shell, "allow-set-title", "off")
  await tmux("select-pane", "-t", shell, "-T", `${name}-shell`)

  // each worker gets its own worktree so workers never share a checkout.
  // launchLine reads the repo record to decide each worker's worktree; a
  // record left by an earlier fleet of this name must not outlive a move to a
  // folder that isn't a repo
  if (await test("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"])) {
    Deno.writeTextFileSync(
      join(rundir, "repo"),
      `${await run("git", ["-C", dir, "rev-parse", "--show-toplevel"])}\n`,
    )
  } else {
    removeIfAny(join(rundir, "repo"))
  }

  for (let i = 1; i <= count; i++) {
    const seat = `${name}-w${i}`
    render("worker.md", seat)
    await launch(
      fleet,
      panes[i - 1],
      `w${i}`,
      `${claude} -n ${seat} --settings ${shq(rundir)}/worker-settings.json --append-system-prompt-file ${
        shq(rundir)
      }/${seat}.md --permission-mode ${mode}${workerFlags}`,
    )
  }

  await attach(name)
}

const tilde = (path: string) => path.startsWith(env("HOME")) ? "~" + path.slice(env("HOME").length) : path
const pad = (text: string, width: number) => text.padEnd(width)

// A fleet is running while its tmux session exists, and stopped while only
// its state folder does. Fleets from before the state folder have no repo
// record, so their repo and worktrees show as -.
export async function ls() {
  const running = new Set(
    (await output("tmux", ["list-sessions", "-F", "#{session_name} #{@fleet}"]))
      .split("\n")
      .map((line) => line.split(" "))
      .filter(([, flag]) => flag === "1")
      .map(([name]) => name),
  )
  const dirs = (dir: string, keep: (p: string) => boolean) =>
    isDir(dir)
      ? [...Deno.readDirSync(dir)].filter((e) => e.isDirectory && keep(join(dir, e.name))).map((e) => e.name)
      : []
  // notes folders whose fleet has neither a session nor a state folder show
  // as `notes`, so leftovers are visible
  const names = [
    ...new Set([...running, ...dirs(statedir, () => true), ...dirs(home, (p) => isDir(join(p, ".git")))]),
  ].sort()
  if (!names.length) return
  const row = (cols: string[]) =>
    print(`${pad(cols[0], 20)} ${pad(cols[1], 8)} ${pad(cols[2], 9)} ${pad(cols[3], 40)} ${cols[4]}`)
  row(["FLEET", "STATE", "WORKTREES", "REPO", "NOTES"])
  for (const name of names) {
    let st = running.has(name) ? "running" : "stopped"
    const rundir = join(statedir, name)
    if (st === "stopped" && !isDir(rundir)) st = "notes"
    const repo = isFile(join(rundir, "repo")) ? readRecord(join(rundir, "repo")) : "-"
    let notes = join(home, name)
    if (isFile(join(rundir, "notes"))) notes = readRecord(join(rundir, "notes"))
    else if (st === "running") {
      notes = await output("tmux", ["show", "-qv", "-t", target(name), "@fleet_notes"])
    }
    let count = "-"
    if (repo !== "-") {
      const wts = join(repo, ".claude", "worktrees")
      count = String(dirs(wts, (p) => new RegExp(`/${name}-w\\d+$`).test(p)).length)
    }
    row([name, st, count, tilde(repo), tilde(notes)])
  }
}

export async function kill(fleet: Fleet) {
  // the seats' SessionEnd hooks would otherwise notify a dying orchestrator
  await tmux("set", "-t", fleet.target, "@fleet_stopping", "1")
  await tmux("kill-session", "-t", fleet.target)
}

export async function clean(args: string[]) {
  const name = args[0] || die("usage: fleet clean <name> [--branches]")
  const branches = args[1] === "--branches"
  if (await test("tmux", ["has-session", "-t", target(name)])) {
    die(`${name} is running; fleet kill ${name} first`)
  }
  const rundir = join(statedir, name)
  if (!isDir(rundir)) die(`no state for ${name} in ${rundir}`)

  let kept = false
  const repo = isFile(join(rundir, "repo")) ? readRecord(join(rundir, "repo")) : ""
  const wtdir = join(repo, ".claude", "worktrees")
  if (repo && isDir(wtdir)) {
    const wts = [...Deno.readDirSync(wtdir)]
      .filter((e) => e.isDirectory && new RegExp(`^${name}-(w\\d+|pair-.+)$`).test(e.name))
      .map((e) => join(wtdir, e.name))
      .sort()
    for (const wt of wts) {
      // read the branch before removal; it is the one Claude Code created
      const branch = await output("git", ["-C", wt, "symbolic-ref", "-q", "--short", "HEAD"])
      // git refuses to remove a worktree with uncommitted or untracked changes
      if (!(await succeeds("git", ["-C", repo, "worktree", "remove", wt]))) {
        warn(`kept ${wt}`)
        kept = true
        continue
      }
      print(`removed ${wt}`)
      // git branch -d refuses a branch that is not merged, so unmerged work stays
      if (
        branches && branch && !(await succeeds("git", ["-C", repo, "branch", "-d", branch]))
      ) {
        warn(`kept unmerged branch ${branch}`)
      }
    }
  }

  // the repo path is how a later clean finds a worktree that was kept
  if (kept) die(`kept worktrees with changes; commit or discard them, then rerun fleet clean ${name}`)
  Deno.removeSync(rundir, { recursive: true })
  print(`removed ${rundir}. Notes stay in ${join(home, name)}`)
}
