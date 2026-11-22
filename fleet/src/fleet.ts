// One fleet: its tmux session, its seats, its notes repo and its state
// folder. Each fleet is one tmux session with an orchestrator seat in window
// `orch` and worker seats w1..wN in window `workers`. Seats share task notes
// in $FLEET_HOME/<fleet>/tasks, a git repo, so `git diff` there shows what
// agents wrote since the last assignment.

import { dirname, fromFileUrl, join } from "@std/path"
import { type Agent, agentNamed } from "./agent/agent.ts"
import { get, path as notePath } from "./note.ts"
import { die, isDir, isFile, output, readRecord, readText, run, sleep, writeAtomic } from "./run.ts"

export const root = dirname(dirname(fromFileUrl(import.meta.url)))
const env = (name: string) => Deno.env.get(name) ?? ""
export const home = env("FLEET_HOME") || join(env("HOME"), "agents")
// Rendered prompts and settings, and the repo path for `clean`. Seats read
// them at every launch, including `restart`, so they live outside $TMPDIR,
// which macOS empties of files nobody has opened for a few days.
export const statedir = join(env("XDG_STATE_HOME") || join(env("HOME"), ".local", "state"), "fleet")

export const tmux = (...args: string[]) => run("tmux", args)

// A pane or session option, empty when unset
export const opt = (target: string, name: string) =>
  output("tmux", ["display", "-p", "-t", target, `#{${name}}`])

// A session target that names the session itself: `=name` alone would match
// a window of that name inside option commands
export const target = (name: string) => `=${name}:`

export async function isFleet(name: string): Promise<boolean> {
  return (await output("tmux", ["show", "-qv", "-t", target(name), "@fleet"])) === "1"
}

export const isWorker = (seat: string) => /^w\d+$/.test(seat)

export function needId(id: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) die(`task ids use letters, digits, - and _: ${id}`)
}

export class Fleet {
  private constructor(readonly name: string, readonly notes: string) {}

  // The fleet named by -s, or else the one that owns the calling pane
  static async current(name?: string): Promise<Fleet> {
    if (!name) {
      const pane = env("TMUX_PANE")
      if (!pane) die("not in a fleet pane, pass -s <fleet>")
      name = await run("tmux", ["display", "-p", "-t", pane, "#S"])
    }
    if (!(await isFleet(name))) die(`${name} is not a fleet`)
    // an empty path would point git -C and the notes lock at the caller's folder
    const notes = await output("tmux", ["show", "-qv", "-t", target(name), "@fleet_notes"])
    if (!notes) die(`${name} has no notes folder recorded in @fleet_notes`)
    return new Fleet(name, notes)
  }

  static at(name: string, notes: string) {
    return new Fleet(name, notes)
  }

  get target() {
    return target(this.name)
  }

  get rundir() {
    return join(statedir, this.name)
  }

  // The agent the fleet's seats run, from the state folder's agent file
  get agent(): Agent {
    const record = join(this.rundir, "agent")
    return agentNamed(isFile(record) ? readRecord(record) : "")
  }

  // The fleet's own repo, where its workers start, or empty outside a repo.
  // Tasks work here unless their note names another of the fleet's repos.
  get repo(): string {
    const record = join(this.rundir, "repo")
    return isFile(record) ? readRecord(record) : ""
  }

  // Every repo the fleet's tasks may work in, the fleet's own first. The
  // state folder's `repos` file lists the others, one per line.
  get repos(): string[] {
    const record = join(this.rundir, "repos")
    const others = isFile(record) ? readText(record).split("\n").map((l) => l.trim()).filter(Boolean) : []
    return [...new Set([this.repo, ...others].filter(Boolean))]
  }

  // The repo a task works in: its note's `repo:`, or the fleet's own
  repoOf(notePath: string): string {
    return get(notePath, "repo") || this.repo
  }

  // The repo of the task a seat holds, or the fleet's own when it holds none
  async seatRepo(seat: string): Promise<string> {
    const task = isWorker(seat) ? await opt(await this.pane(seat), "@agent_task") : ""
    const path = task ? notePath(this.notes, task) : ""
    return path && isFile(path) ? this.repoOf(path) : this.repo
  }

  // [pane id, seat, task] for every seat pane; the notes editor and shell
  // windows have no @agent_seat, so they are left out
  async seats(): Promise<{ pane: string; seat: string; task: string }[]> {
    const out = await run("tmux", [
      "list-panes",
      "-s",
      "-t",
      this.target,
      "-F",
      "#{pane_id}\t#{@agent_seat}\t#{@agent_task}",
    ])
    return out.split("\n").map((line) => {
      const [pane, seat, task] = line.split("\t")
      return { pane, seat, task }
    }).filter((s) => s.seat)
  }

  async pane(seat: string): Promise<string> {
    const found = (await this.seats()).find((s) => s.seat === seat)
    if (!found) die(`no seat ${seat} in ${this.name}`)
    return found.pane
  }

  // A worker seat's checkout in a repo, the fleet's own by default, or empty
  // when there is none yet. ensureWorktree creates it.
  checkout(seat: string, repo = this.repo): string {
    if (!repo) return ""
    const wt = join(repo, ".claude", "worktrees", `${this.name}-${seat}`)
    return isDir(wt) ? wt : ""
  }

  // A seat's checkout in a repo, created on first use the way Claude Code's
  // -w would, and its branch recorded, since a repo's WorktreeCreate hook
  // names the branch itself
  async ensureWorktree(seat: string, repo: string): Promise<string> {
    const existing = this.checkout(seat, repo)
    if (existing) return existing
    const branch = await this.agent.createWorktree(repo, `${this.name}-${seat}`)
    const record = join(this.rundir, "branches")
    const kept = isFile(record)
      ? readText(record).split("\n").filter((l) => l && !l.startsWith(`${repo}\t${seat}\t`))
      : []
    writeAtomic(record, [...kept, `${repo}\t${seat}\t${branch}`].join("\n") + "\n")
    return this.checkout(seat, repo)
  }

  // The branch a seat's worktree in a repo was created on. A worktree made
  // before fleet recorded branches is on worktree-<fleet>-<seat>, the name
  // Claude Code gives it without a hook.
  seatBranch(seat: string, repo: string): string {
    const record = join(this.rundir, "branches")
    if (isFile(record)) {
      for (const line of readText(record).split("\n")) {
        const [r, s, branch] = line.split("\t")
        if (r === repo && s === seat && branch) return branch
      }
    }
    return `worktree-${this.name}-${seat}`
  }

  // Like checkout, but stops fleet with the reason there is no checkout. The
  // repo defaults to that of the task the seat holds.
  async worktree(seat: string, repo?: string): Promise<string> {
    if (!isWorker(seat)) die(`only worker seats have worktrees: ${seat}`)
    await this.pane(seat)
    repo ??= await this.seatRepo(seat)
    if (!repo) die(`${this.name} has no repo record, so its workers have no worktrees`)
    const wt = this.checkout(seat, repo)
    if (!wt) die(`no worktree yet at ${repo}/.claude/worktrees/${this.name}-${seat}`)
    return wt
  }

  // Commits everything in the notes repo under a lock, so commands running at
  // once, such as the orchestrator's parallel assigns, don't collide on git's
  // index.lock. mkdir is atomic, which makes the folder a lock.
  async commit(message: string) {
    const lock = join(this.notes, ".git", "fleet.lock")
    for (let tries = 0;; tries++) {
      try {
        Deno.mkdirSync(lock)
        break
      } catch {
        if (tries >= 100) die(`the notes repo stayed locked; remove ${lock} if no fleet command is running`)
        await sleep(100)
      }
    }
    try {
      await run("git", ["-C", this.notes, "add", "-A"])
      await run("git", ["-C", this.notes, "commit", "-q", "--allow-empty", "-m", message])
    } finally {
      Deno.removeSync(lock)
    }
  }

  async needIdle(pane: string, seat: string) {
    const st = await opt(pane, "@agent_state")
    if (st !== "idle") die(`${seat} is ${st || "starting"}, not idle`)
  }

  // Stops fleet when the seat's session can't take a message yet
  async needReady(pane: string) {
    if (!(await this.agent.ready(pane))) {
      const seat = await opt(pane, "@agent_seat")
      die(
        `${seat}'s session can't take messages yet; a seat started before fleet recorded sessions needs fleet restart`,
      )
    }
  }

  // Who a message is from: the seat of the pane, the calling one by default,
  // when it belongs to this fleet, otherwise the user.
  async sender(pane = env("TMUX_PANE")): Promise<string> {
    let seat = ""
    if (pane && (await output("tmux", ["display", "-p", "-t", pane, "#S"])) === this.name) {
      seat = await opt(pane, "@agent_seat")
    }
    if (seat === "orch") return `the orchestrator ${this.name}-orch`
    if (isWorker(seat)) return `worker ${this.name}-${seat}`
    return "the user"
  }

  // Delivers one message to a seat, headed with its sender, the seat of the
  // pane from when given, and the skill that handles it
  async post(pane: string, skill: string, text: string, from?: string) {
    await this.needReady(pane)
    const seat = await opt(pane, "@agent_seat")
    try {
      await this.agent.deliver(pane, `${this.agent.header(await this.sender(from), skill)}\n${text}`)
    } catch {
      die(`could not deliver to ${seat}`)
    }
  }

  // w2 from a worker: field such as demo-w2
  seatOf(worker: string): string {
    return worker.startsWith(`${this.name}-`) ? worker.slice(this.name.length + 1) : worker
  }

  // The seat still on task <id>, or stops fleet when no worker is
  async workerOn(id: string, note: string) {
    if (!isFile(note)) die(`no task note ${note}`)
    const seat = this.seatOf(get(note, "worker"))
    if (!seat) die(`${id} is not assigned`)
    const pane = await this.pane(seat)
    if ((await opt(pane, "@agent_task")) !== id) {
      die(`${seat} is no longer on ${id}; start a follow-up task with fleet task`)
    }
    return { seat, pane, state: await opt(pane, "@agent_state") }
  }
}
