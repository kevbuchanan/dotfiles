// One fleet: its tmux session, its seats, its notes repo and its state
// folder. Each fleet is one tmux session with an orchestrator seat in window
// `orch` and worker seats w1..wN in window `workers`. Seats share task notes
// in $FLEET_HOME/<fleet>/tasks, a git repo, so `git diff` there shows what
// agents wrote since the last assignment.

import { dirname, fromFileUrl, join } from "@std/path"
import { postToSession } from "../../lib/claude/session.ts"
import { defaultBranch } from "./git.ts"
import { get, path as notePath } from "./note.ts"
import { die, isDir, isFile, isSocket, output, readRecord, readText, run, sleep, test } from "./run.ts"

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
  // when there is none. In the fleet's own repo, Claude Code creates it from
  // the -w name on the seat's launch line; in another, ensureWorktree does.
  checkout(seat: string, repo = this.repo): string {
    if (!repo) return ""
    const wt = join(repo, ".claude", "worktrees", `${this.name}-${seat}`)
    return isDir(wt) ? wt : ""
  }

  // A seat's checkout in a repo other than the fleet's own, created on first
  // use on branch worktree-<fleet>-<seat>, the name Claude Code gives the
  // seat's branch in the fleet's own repo, from the repo's default branch.
  async ensureWorktree(seat: string, repo: string): Promise<string> {
    const existing = this.checkout(seat, repo)
    if (existing || repo === this.repo) return existing
    const wt = join(repo, ".claude", "worktrees", `${this.name}-${seat}`)
    const branch = `worktree-${this.name}-${seat}`
    if (await test("git", ["-C", repo, "rev-parse", "-q", "--verify", `refs/heads/${branch}`])) {
      await run("git", ["-C", repo, "worktree", "add", "-q", wt, branch])
    } else {
      const start = (await defaultBranch(repo)) || "HEAD"
      await run("git", ["-C", repo, "worktree", "add", "-q", "-b", branch, wt, start])
    }
    return wt
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

  async needSocket(pane: string) {
    if (!isSocket(await opt(pane, "@agent_socket"))) {
      die(
        `${await opt(
          pane,
          "@agent_seat",
        )} has no inbox socket recorded; a seat started before fleet recorded sockets needs fleet restart`,
      )
    }
  }

  // Who a message is from: the seat of the calling pane when it belongs to
  // this fleet, otherwise the user.
  async sender(): Promise<string> {
    const pane = env("TMUX_PANE")
    let seat = ""
    if (pane && (await output("tmux", ["display", "-p", "-t", pane, "#S"])) === this.name) {
      seat = await opt(pane, "@agent_seat")
    }
    if (seat === "orch") return `the orchestrator ${this.name}-orch`
    if (isWorker(seat)) return `worker ${this.name}-${seat}`
    return "the user"
  }

  // Writes one message to a seat's inbox socket, headed with its sender and
  // the skill that handles it
  async post(pane: string, skill: string, text: string) {
    await this.needSocket(pane)
    const socket = await opt(pane, "@agent_socket")
    const seat = await opt(pane, "@agent_seat")
    const message = `From fleet, sent by ${await this.sender()} (handle per /fleet:${skill} skill):\n${text}`
    try {
      await postToSession({ socket }, message)
    } catch {
      die(`could not deliver to ${seat} at ${socket}`)
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
