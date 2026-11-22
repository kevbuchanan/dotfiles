// Tasks and the seats that work them. Task messages (assign, bump, answer,
// report) go to a seat's session through the agent, src/agent/agent.ts. With
// Claude Code they go to its inbox socket, which the register hook records on
// the pane, and Claude Code treats them as messages from another session:
// they can't approve a permission prompt, and a busy session reads them
// between tool calls. The agent types its reset and interrupt keys and the
// launch line into panes, because commands that arrive over the socket don't
// run.

import { basename, join, relative } from "@std/path"
import { Fleet, isWorker, needId, opt, readState, root, setOpt, setState, tmux, unsetOpt } from "../fleet.ts"
import * as note from "../note.ts"
import {
  die,
  exists,
  fill,
  isFile,
  output,
  print,
  readText,
  run,
  sleep,
  stamp,
  test,
  today,
  warn,
  writeAtomic,
} from "../run.ts"
import { borders, launchLine } from "./lifecycle.ts"
import { fetchOrigin, sync } from "./diff.ts"
import { defaultBranch } from "../git.ts"
import * as wip from "../wip.ts"

const env = (name: string) => Deno.env.get(name) ?? ""
const pad = (text: string, width: number) => text.padEnd(width)

export async function status(fleet: Fleet) {
  const row = (c: string[]) =>
    print(`${pad(c[0], 8)} ${pad(c[1], 10)} ${pad(c[2], 28)} ${pad(c[3], 10)} ${c[4]}`)
  row(["SEAT", "STATE", "TASK", "REPORT", "TODOS"])
  for (const { pane, seat } of await fleet.seats()) {
    const st = await readState(pane)
    const task = await opt(pane, "@agent_task")
    let progress = ""
    let report = ""
    const path = join(fleet.notes, "tasks", `${task}.md`)
    if (task && isFile(path)) {
      const [done, total, open] = await note.progress(root, path)
      progress = `${done}/${total}${open ? `, ${open} open questions` : ""}`
      report = note.get(path, "status")
    }
    row([seat, st || "-", task || "-", report || "-", progress])
  }
}

export async function task(fleet: Fleet, args: string[]) {
  const usage =
    "usage: fleet task <id> [--repo <path>] [--from <id>] [--start <ref>] [--branch <name>] <title>"
  const id = args[0] || die(usage)
  let from = ""
  let repo = ""
  let start = ""
  let branch = ""
  const words: string[] = []
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--from") {
      from = args[++i] || die("--from needs a task id")
    } else if (args[i] === "--start") {
      start = args[++i] || die("--start needs a ref")
    } else if (args[i] === "--branch") {
      branch = args[++i] || die("--branch needs a name")
    } else if (args[i] === "--repo") {
      const dir = args[++i] || die("--repo needs a path")
      if (!(await test("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]))) {
        die(`not a git repo: ${dir}`)
      }
      repo = await run("git", ["-C", dir, "rev-parse", "--show-toplevel"])
      if (!fleet.repos.includes(repo)) {
        die(`${repo} is not one of ${fleet.name}'s repos; fleet repo add ${repo} first`)
      }
    } else {
      words.push(args[i])
    }
  }
  needId(id)
  // the id is the note's file name and the label on the board and in reports
  if (/^[A-Za-z]?\d+$/.test(id)) {
    die(`task id ${id} names no work; use a short slug such as csv-export or abc-123-csv-export`)
  }
  let path = note.path(fleet.notes, id)
  if (exists(path)) die(`${path} exists`)
  let prev = ""
  if (from) {
    needId(from)
    prev = note.path(fleet.notes, from)
    path = join(fleet.notes, "tasks", `${id}.md`)
    if (!isFile(prev)) die(`no task note for ${from}`)
    if (!note.get(prev, "end")) die(`${from} is still open; add the work to its note and fleet bump ${from}`)
    if (!words.length) words.push("follow-up", "to", from)
  }
  // A follow-up to a task on a branch of its own continues that branch from
  // where the task ended, unless it names a start or a branch
  if (from && !start && !branch && note.get(prev, "start") && note.get(prev, "end") !== "-") {
    start = note.get(prev, "end")
    branch = note.get(prev, "branch")
  }
  if (start || branch) {
    const dir = repo || (prev && note.get(prev, "repo")) || fleet.repo
    if (!dir) die("--start and --branch need the task to work in a repo")
    start ||= await defaultBranch(dir)
    if (!start) die(`no default branch found in ${dir}; give --start`)
    if (!(await test("git", ["-C", dir, "rev-parse", "-q", "--verify", `${start}^{commit}`]))) {
      die(`start ${start} is not a commit in ${dir}`)
    }
    branch ||= id
    if (!(await test("git", ["-C", dir, "check-ref-format", "--branch", branch]))) {
      die(`not a branch name: ${branch}`)
    }
  }
  // a fleet's own guidance/default.md replaces the built-in one
  let guidance = join(root, "guidance", "default.md")
  if (isFile(join(fleet.notes, "guidance", "default.md"))) {
    guidance = join(fleet.notes, "guidance", "default.md")
  }
  // written beside the note and moved into place, so a failed render leaves
  // no half-made note to block a retry
  writeAtomic(
    path,
    fill(readText(join(root, "templates", "task.md")), {
      FLEET: fleet.name,
      DATE: today(),
      ID: id,
      TITLE: words.join(" ") || "untitled",
      GUIDANCE: guidance,
    }),
  )

  // A follow-up starts from the earlier task's handoff, with its scope and
  // checks, so the new worker needs none of the earlier conversation
  if (from) {
    note.set(path, "follows", from, fleet.name)
    // a follow-up works where the task it follows did
    repo ||= note.get(prev, "repo")
    for (const sec of ["Scope", "Verify"]) note.setSection(path, sec, note.section(prev, sec))
    // the link is relative to tasks/, where the new note lives, and reaches a
    // source archived under archive/<month>/
    const link = relative(join(fleet.notes, "tasks"), prev)
    note.setSection(path, "Goal", [
      "",
      `Follow-up to [${from}](${link}). Read its Handoff first: it says what ${from} did and what is left.`,
      "",
    ])
  }
  if (repo && repo !== fleet.repo) note.set(path, "repo", repo, fleet.name)

  if (start) {
    note.set(path, "start", start, fleet.name)
    note.set(path, "branch", branch, fleet.name)
  }
  print(path)
}

export async function assign(fleet: Fleet, args: string[]) {
  const usage = "usage: fleet assign [--no-sync] <seat> <task id>"
  let doSync = true
  if (args[0] === "--no-sync") {
    doSync = false
    args = args.slice(1)
  }
  const seat = args[0] || die(usage)
  const id = args[1] || die(usage)
  if (!isWorker(seat)) die(`only worker seats take tasks: ${seat}`)
  needId(id)
  const path = note.path(fleet.notes, id)
  if (path.includes("/archive/")) {
    die(`${id} is archived; put follow-up work in a new task, such as fleet task ${id}-2 --from ${id}`)
  }
  const pane = await fleet.pane(seat)
  if (!isFile(path)) die(`no task note ${path}`)
  await fleet.needIdle(pane, seat)
  await fleet.needReady(pane)
  // reassigning would overwrite base, and `fleet diff` would lose the closed work
  if (note.get(path, "end")) {
    die(`${id} is closed; put follow-up work in a new task, such as fleet task ${id}-2 --from ${id}`)
  }
  // one task per seat and one seat per task: a second holder would overwrite
  // base, and a seat's earlier task would never get its end
  const held = await opt(pane, "@agent_task")
  if (held) die(`${seat} still holds ${held}; fleet clear ${seat} first`)
  const holder = (await fleet.seats()).find((s) => s.task === id)
  if (holder) die(`${holder.seat} already holds ${id}`)

  // A follow-up builds on the earlier task's code; check it before touching
  // the worktree, so a refusal leaves nothing changed
  const follows = note.get(path, "follows")
  let prev = ""
  let prevEnd = ""
  if (follows) {
    prev = note.path(fleet.notes, follows)
    if (!isFile(prev)) die(`${id} follows ${follows}, which has no note`)
    prevEnd = note.get(prev, "end")
    if (!prevEnd) die(`${follows} is still open; add the work to its note and fleet bump ${follows}`)
  }

  // the task works in its note's repo, the fleet's own unless it names
  // another; there the seat gets a worktree of its own on first use
  const repo = fleet.repoOf(path)
  if (repo && !fleet.repos.includes(repo)) {
    die(`${id} works in ${repo}, which is not one of ${fleet.name}'s repos; fleet repo add ${repo} first`)
  }
  if (follows && fleet.repoOf(prev) !== repo) {
    die(`${id} works in ${repo || "no repo"}, but ${follows} worked in ${fleet.repoOf(prev) || "no repo"}`)
  }

  // base is the worker branch's commit when the task starts, and end is set
  // by `fleet clear`, so `fleet diff` can show this task apart from the
  // branch's earlier and later tasks
  const worktree = repo ? await fleet.ensureWorktree(seat, repo) : ""
  // A task with `start:` works on a branch of its own, checked out from that
  // ref; any other task works on the seat's branch, brought up to date with
  // the default branch
  const start = note.get(path, "start")
  let branch = start ? note.get(path, "branch") || id : fleet.seatBranch(seat, repo)
  let base = "-"
  let target = "HEAD"
  if (worktree && start) {
    target = await taskBranchHead(worktree, seat, branch, start)
  } else if (worktree) {
    await home(fleet, repo, worktree, seat, die)
    if (doSync) await sync(worktree, seat)
    branch = (await output("git", ["-C", worktree, "symbolic-ref", "-q", "--short", "HEAD"])) || branch
  }

  // the task's branch must contain the earlier task's end, checked before a
  // task branch is checked out, so a refusal leaves the worktree as it was
  if (follows && worktree && prevEnd !== "-") {
    if (!(await test("git", ["-C", worktree, "merge-base", "--is-ancestor", prevEnd, target]))) {
      die(
        `${seat}'s branch doesn't contain ${follows}'s work (${prevEnd.slice(0, 12)}); assign ${id} to ${
          fleet.seatOf(note.get(prev, "worker"))
        } or merge ${note.get(prev, "branch")} into ${branch} first`,
      )
    }
  }
  if (worktree && start) await checkoutTaskBranch(worktree, seat, branch, target)
  if (worktree) base = await run("git", ["-C", worktree, "rev-parse", "HEAD"])

  note.set(path, "worker", `${fleet.name}-${seat}`, fleet.name)
  note.set(path, "branch", branch, fleet.name)
  note.set(path, "base", base, fleet.name)
  note.set(path, "end", "", fleet.name)
  note.set(path, "status", "assigned", fleet.name)

  // the commit is the baseline that `git diff` in the notes repo compares against
  await fleet.commit(`assign ${id} to ${seat}`)

  await setOpt(pane, "@agent_task", id)
  await tmux("select-pane", "-t", pane, "-T", `${fleet.name}-${seat}: ${id}`)
  const where = repo && repo !== fleet.repo ? ` It works in ${repo}, in your worktree ${worktree}.` : ""
  await fleet.post({ pane, skill: "worker" }, `Task ${id}: read ${path}.${where}`)
}

// Records the task's end at the worktree's HEAD, or `-` in a fleet outside a
// repo, which has no commit to record but closes the task the same way for
// archive, follow-ups and reassign checks
async function close(
  fleet: Fleet,
  seat: string,
  path: string,
  verb: string,
  extra: Record<string, string> = {},
) {
  const worktree = fleet.checkout(seat, fleet.repoOf(path))
  // saved first: a failure leaves the task open and the worktree as it was
  if (worktree) await wip.save(fleet, worktree, basename(path).replace(/\.md$/, ""), path, verb)
  const end = worktree ? await run("git", ["-C", worktree, "rev-parse", "HEAD"]) : "-"
  note.set(path, "end", end, fleet.name)
  note.set(path, "closed", today(), fleet.name)
  for (const [key, value] of Object.entries(extra)) note.set(path, key, value, fleet.name)
  // frees a task branch for a pair or a follow-up on another seat, since git
  // checks a branch out in one worktree at a time
  if (worktree && note.get(path, "start")) await home(fleet, fleet.repoOf(path), worktree, seat, warn)
  return worktree
}

// Puts a worktree back on its seat's branch after a task on a branch of its
// own. Untracked files that fleet clear left in place stay.
async function home(fleet: Fleet, repo: string, worktree: string, seat: string, fail: (msg: string) => void) {
  const branch = fleet.seatBranch(seat, repo)
  const current = await output("git", ["-C", worktree, "symbolic-ref", "-q", "--short", "HEAD"])
  if (current === branch) return
  if (!(await test("git", ["-C", worktree, "rev-parse", "-q", "--verify", `refs/heads/${branch}`]))) return
  if (!(await test("git", ["-C", worktree, "switch", "-q", branch], { quiet: false }))) {
    fail(`could not switch ${seat}'s worktree from ${current || "a detached HEAD"} back to ${branch}`)
  }
}

// The commit a task branch is checked out at: an existing branch continues
// when it contains the start, and a new one starts there
async function taskBranchHead(worktree: string, seat: string, branch: string, start: string) {
  if (await output("git", ["-C", worktree, "status", "--porcelain", "--untracked-files=no"])) {
    die(`${seat}'s worktree has uncommitted changes; commit or stash them with fleet shell ${seat} first`)
  }
  await fetchOrigin(worktree, seat)
  const commit = await output("git", ["-C", worktree, "rev-parse", "-q", "--verify", `${start}^{commit}`])
  if (!commit) die(`start ${start} is not a commit in ${seat}'s worktree`)
  const head = await output("git", ["-C", worktree, "rev-parse", "-q", "--verify", `refs/heads/${branch}`])
  if (!head) return commit
  if (!(await test("git", ["-C", worktree, "merge-base", "--is-ancestor", commit, head]))) {
    die(
      `branch ${branch} exists and doesn't contain ${start}; merge ${start} into it, or give the task another --branch`,
    )
  }
  return head
}

// --no-track: a start such as origin/<mr branch> would otherwise become the
// task branch's upstream, and a plain git push would go to that MR
async function checkoutTaskBranch(worktree: string, seat: string, branch: string, at: string) {
  const exists = await test("git", ["-C", worktree, "rev-parse", "-q", "--verify", `refs/heads/${branch}`])
  const args = exists ? ["switch", "-q", branch] : ["switch", "-q", "--no-track", "-c", branch, at]
  if (!(await test("git", ["-C", worktree, ...args], { quiet: false }))) {
    die(
      `could not check out ${branch} in ${seat}'s worktree; git checks a branch out in one worktree at a time`,
    )
  }
}

export async function clear(fleet: Fleet, args: string[]) {
  const seat = args[0] || die("seat")
  const pane = await fleet.pane(seat)
  await fleet.needIdle(pane, seat)
  const id = await opt(pane, "@agent_task")
  const path = join(fleet.notes, "tasks", `${id}.md`)
  if (id && isFile(path)) {
    // a task waiting on the user's answers stays open; abandon closes it
    const [, , open] = await note.progress(root, path)
    if (open) {
      die(`${id} has ${open} open questions; wait for the answers, or fleet abandon ${seat} to close it`)
    }
    await close(fleet, seat, path, "clear")
  }
  await unsetOpt(pane, "@agent_task")
  await tmux("select-pane", "-t", pane, "-T", `${fleet.name}-${seat}`)
  await fleet.agent.reset(pane)
}

// A seat holding a task keeps it across the restart: the new session gets
// the task line again once its register hook records the socket, and the
// note's base and todos carry the work on. @agent_state `restarting` tells
// the old session's SessionEnd hook not to report the end.
export async function restart(fleet: Fleet, args: string[]) {
  const seat = args[0] || die("seat")
  const pane = await fleet.pane(seat)
  const id = await opt(pane, "@agent_task")
  await setState(pane, "restarting")
  await unsetOpt(pane, "@agent_socket")
  await unsetOpt(pane, "@agent_session")
  await tmux("respawn-pane", "-k", "-t", pane)
  await unsetOpt(pane, "@agent_state")
  await tmux("send-keys", "-t", pane, await launchLine(fleet, pane), "Enter")
  if (!id) return
  const path = note.path(fleet.notes, id)
  for (let tries = 0; !(await fleet.agent.ready(pane)); tries++) {
    if (tries >= 120) {
      die(
        `${seat} did not start within a minute; it still holds ${id}, so run fleet bump ${id} once it is up`,
      )
    }
    await sleep(500)
  }
  await fleet.post(
    { pane, skill: "worker" },
    `Task ${id}: your session restarted. Read ${path} and continue from its Todo and Log.`,
  )
  print(`restarted ${seat} on ${id}`)
}

// Closes a seat's task from any state, for a worker that is stalled, stuck
// on a question nobody will answer, or whose session ended: the note gets
// end, closed and status abandoned, and the seat drops the task. A live
// session is interrupted and cleared; a dead one stays down until fleet
// restart. The worktree keeps any work, and the next task's diff starts
// from the end recorded here.
export async function abandon(fleet: Fleet, args: string[]) {
  const seat = args[0] || die("usage: fleet abandon <seat>")
  const pane = await fleet.pane(seat)
  const id = await opt(pane, "@agent_task")
  if (!id) die(`${seat} holds no task`)
  const path = note.path(fleet.notes, id)
  if (isFile(path)) {
    await close(fleet, seat, path, "abandon", { status: "abandoned" })
    note.appendLog(
      path,
      `${stamp()} abandoned: closed by ${await fleet.sender()} from seat state ${
        (await readState(pane)) || "none"
      }`,
    )
  }
  await unsetOpt(pane, "@agent_task")
  await tmux("select-pane", "-t", pane, "-T", `${fleet.name}-${seat}`)
  if (await fleet.agent.ready(pane)) {
    await fleet.agent.interrupt(pane)
    await sleep(500)
    await fleet.agent.reset(pane)
  } else {
    warn(`${seat} has no live session; fleet restart ${seat} relaunches it`)
  }
  print(`abandoned ${id} on ${seat}`)
}

export async function interrupt(fleet: Fleet, args: string[]) {
  await fleet.agent.interrupt(await fleet.pane(args[0] || die("seat")))
}

export async function rename(fleet: Fleet, args: string[]) {
  const pane = await fleet.pane(args[0] || die("seat"))
  await tmux("select-pane", "-t", pane, "-T", args[1] || die("title"))
}

export async function path(fleet: Fleet, args: string[]) {
  print(await fleet.worktree(args[0] || die("seat")))
}

// A window per worker shell: the tiled workers window has no room for more
// panes. It has no @agent_seat, so seat commands and `fleet status` skip it.
export async function shell(fleet: Fleet, args: string[]) {
  const seat = args[0] || die("seat")
  const command = args.slice(1).join(" ")
  const worktree = await fleet.worktree(seat)
  const win = `${seat}-shell`
  const windows = (await run("tmux", ["list-windows", "-t", fleet.target, "-F", "#{window_name}"])).split(
    "\n",
  )
  if (windows.includes(win)) {
    if (command) warn(`${win} is already open; run the command there`)
  } else {
    const pane = await run("tmux", [
      "new-window",
      "-d",
      "-t",
      fleet.target,
      "-n",
      win,
      "-c",
      worktree,
      "-P",
      "-F",
      "#{pane_id}",
    ])
    await borders(`=${fleet.name}:${win}`)
    await tmux("set", "-p", "-t", pane, "allow-set-title", "off")
    await tmux("select-pane", "-t", pane, "-T", `${fleet.name}-${win}`)
    if (command) await tmux("send-keys", "-t", pane, command, "Enter")
  }
  if (env("TMUX")) await tmux("switch-client", "-t", `=${fleet.name}:${win}`)
  else print(`opened ${fleet.name}:${win}; fleet attach ${fleet.name} to use it`)
}

// A stopped worker starts a turn when the message arrives, and a busy one
// reads it between tool calls, so any state will do.
export async function bump(fleet: Fleet, args: string[]) {
  const id = args[0] || die("usage: fleet bump <task id>")
  needId(id)
  const path = join(fleet.notes, "tasks", `${id}.md`)
  const { seat, pane } = await fleet.workerOn(id, path)
  await fleet.post({ pane, skill: "worker" }, `Task ${id} was updated: re-read ${path}`)
  print(`told ${seat} that ${id} was updated`)
}

export async function answer(fleet: Fleet, args: string[]) {
  const id = args[0] || die("usage: fleet answer <task id>")
  needId(id)
  const path = join(fleet.notes, "tasks", `${id}.md`)
  const { seat, pane, state } = await fleet.workerOn(id, path)
  if (state !== "question") die(`${seat} is ${state || "starting"}, not waiting on a question`)
  const [, , open] = await note.progress(root, path)
  if (open !== 0) die(`${id} still has ${open} open questions`)
  await fleet.post({ pane, skill: "worker" }, `Questions in ${id} are answered: re-read ${path}`)
  print(`told ${seat} that ${id}'s questions are answered`)
}

// A worker's report: recorded in the note's status field and Log section,
// and sent to the orchestrator. Only the task's own worker reports on it.
// The question `fleet report review` adds, which the user answers by
// checking one option and then the question line
const APPROVE = [
  "- [ ] Approve: is the result in the Handoff approved? Check one option, then this line.",
  "  - [ ] approve",
  "  - [ ] approve with the changes in my answers above",
  "  - [ ] cancel",
]
const isApprove = (line: string) => /^- \[[ xX]\] Approve:/.test(line)

// Puts a fresh, unchecked approval question last under ## Questions,
// replacing any earlier one, so a second review asks again
function askApproval(path: string) {
  const body: string[] = []
  let inApprove = false
  for (const line of note.section(path, "Questions")) {
    if (isApprove(line)) inApprove = true
    else if (inApprove && !/^\s/.test(line)) inApprove = false
    if (!inApprove) body.push(line)
  }
  while (body[0] === "") body.shift()
  while (body.at(-1) === "") body.pop()
  note.setSection(path, "Questions", ["", ...body, ...(body.length ? [""] : []), ...APPROVE, ""])
}

// whether the approval question is answered
const approved = (path: string) => note.section(path, "Questions").some((l) => /^- \[[xX]\] Approve:/.test(l))

export async function report(fleet: Fleet, args: string[]) {
  const usage = "usage: fleet report <task id> <progress|review|done|blocked|error> <text>"
  const id = args[0] || die(usage)
  if (args.length < 2) die(usage)
  const phase = args[1]
  if (!["progress", "review", "done", "blocked", "error"].includes(phase)) {
    die(`phase must be progress, review, done, blocked or error: ${phase}`)
  }
  const text = args.slice(2).join(" ")
  if (!text) die("a report needs a line of text")
  needId(id)
  const path = join(fleet.notes, "tasks", `${id}.md`)
  const { seat, pane } = await fleet.workerOn(id, path)
  if (env("TMUX_PANE") !== pane) die(`only ${seat}, the worker on ${id}, reports on it`)
  if (phase === "done" || phase === "review") {
    const [done, total, open] = await note.progress(root, path)
    if (done !== total) die(`${id} has ${total - done} unchecked todos; check them or report blocked`)
    if (phase === "done" && open) {
      die(`${id} has ${open} open questions; wait for the answers, or report review or blocked`)
    }
    if (phase === "done" && note.get(path, "approve") === "yes" && !approved(path)) {
      die(
        `${id} needs the user's approval: report review, then report done once its Approve question is answered`,
      )
    }
  }
  // check the orchestrator can take the report before writing anything, so one that
  // can't be delivered (the orchestrator mid-/clear) changes nothing and a
  // retry doesn't log the same line twice
  const orch = await fleet.pane("orch")
  await fleet.needReady(orch)
  if (phase === "review") askApproval(path)
  note.set(path, "status", phase, fleet.name)
  note.appendLog(path, `${stamp()} ${phase}: ${text}`)
  await fleet.post({ pane: orch, skill: "orchestrator" }, `Report: ${id} ${phase}: ${text}`)
  print(`reported ${id} ${phase} to the orchestrator`)
}
