// Diffs of a task or a worker's branch, and bringing a worker's branch up to
// date with the default branch before it starts a task.

import { Fleet, isWorker, needId, opt } from "../fleet.ts"
import * as note from "../note.ts"
import { die, isFile, output, passthrough, print, run, test, warn } from "../run.ts"

// The default branch as seen from checkout <dir>: origin's HEAD when the repo
// has one, else main or master. Empty when none exists.
async function defaultBranch(dir: string): Promise<string> {
  const origin = await output("git", ["-C", dir, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"])
  for (const ref of [...(origin ? [origin] : []), "main", "master"]) {
    if (await test("git", ["-C", dir, "rev-parse", "-q", "--verify", `${ref}^{commit}`])) return ref
  }
  return ""
}

// Merges the default branch into a worker's branch: fetched first when the
// repo has an origin, a fast-forward when the branch has nothing of its own,
// and left alone with uncommitted changes or a conflict.
export async function sync(worktree: string, seat: string) {
  if (await output("git", ["-C", worktree, "status", "--porcelain"])) {
    warn(`${seat}'s worktree has uncommitted changes; left it as is`)
    return
  }
  if (await test("git", ["-C", worktree, "remote", "get-url", "origin"])) {
    if (
      !(await test("git", ["-C", worktree, "fetch", "-q", "origin"], { env: { GIT_TERMINAL_PROMPT: "0" } }))
    ) {
      warn(`fetching origin failed; updating ${seat} from the refs on disk`)
    }
  }
  const ref = await defaultBranch(worktree)
  if (!ref) {
    warn(`no default branch found; ${seat}'s branch is not updated`)
    return
  }
  if (await test("git", ["-C", worktree, "merge-base", "--is-ancestor", ref, "HEAD"])) return
  if (await test("git", ["-C", worktree, "merge-base", "--is-ancestor", "HEAD", ref])) {
    await run("git", ["-C", worktree, "merge", "-q", "--ff-only", ref])
  } else if (!(await test("git", ["-C", worktree, "merge", "-q", "--no-edit", ref], { quiet: false }))) {
    await run("git", ["-C", worktree, "merge", "--abort"])
    die(
      `merging ${ref} into ${seat}'s branch conflicts; resolve it with fleet shell ${seat}, or assign with --no-sync`,
    )
  }
  print(`updated ${seat}'s branch from ${ref}`)
}

async function gitDiff(dir: string, rev: string, args: string[]) {
  const code = await passthrough("git", ["-C", dir, "diff", rev, ...args])
  if (code !== 0) Deno.exit(code)
}

// A worker's branch since it left the default branch, through its working
// tree, so uncommitted edits show.
async function branchDiff(fleet: Fleet, seat: string, revOnly: boolean, args: string[]) {
  const worktree = await fleet.worktree(seat)
  const ref = await defaultBranch(worktree)
  if (!ref) die(`can't find the default branch to diff ${seat}'s branch against`)
  const mb = await run("git", ["-C", worktree, "merge-base", ref, "HEAD"])
  if (revOnly) print(worktree, mb)
  else await gitDiff(worktree, mb, args)
}

// One task's changes. While the task is still its seat's current task, the
// diff runs in the worktree from base, so it includes uncommitted edits to
// tracked files. Once `fleet clear` has recorded end, it is base..end.
export async function diff(fleet: Fleet, args: string[]) {
  let revOnly = false
  if (args[0] === "--rev") {
    revOnly = true
    args = args.slice(1)
  }
  let id = args[0] ?? ""
  let rest = args.slice(1)
  // a seat, or no argument from a worker's own pane, means the whole branch;
  // a task note by that name wins, so a task can be called w2
  if (!id || id.startsWith("-")) {
    rest = args
    const pane = Deno.env.get("TMUX_PANE")
    id = pane ? await opt(pane, "@agent_seat") : ""
    if (!isWorker(id)) die("usage: fleet diff [--rev] [<task id> | <seat>] [git diff args]")
  }
  needId(id)
  const path = note.path(fleet.notes, id)
  if (!isFile(path) && isWorker(id)) return await branchDiff(fleet, id, revOnly, rest)
  if (!isFile(path)) die(`no task note ${path}`)
  const base = note.get(path, "base")
  const end = note.get(path, "end")
  const branch = note.get(path, "branch")
  const seat = fleet.seatOf(note.get(path, "worker"))
  if (!base || base === "-") {
    die(`${id} has no Base; it was assigned before fleet recorded one, or its workers have no worktrees`)
  }
  const repo = fleet.repo
  let dir: string
  let rev: string
  if (end) {
    dir = repo
    rev = `${base}..${end}`
  } else {
    const pane = await fleet.pane(seat)
    const worktree = fleet.checkout(seat)
    if ((await opt(pane, "@agent_task")) === id && worktree) {
      dir = worktree
      rev = base
    } else {
      warn(`${id} has no End; showing ${branch} through its latest commit`)
      dir = repo
      rev = `${base}..${branch}`
    }
  }
  if (revOnly) print(dir, rev)
  else await gitDiff(dir, rev, rest)
}
