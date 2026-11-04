// Tasks and the seats that work them. Task messages (assign, bump, answer,
// report) go to a seat's Claude Code inbox socket, which the register hook
// records on its pane. Claude Code treats them as messages from another
// session: they can't approve a permission prompt, and a busy session reads
// them between tool calls. Only /clear, Escape and the launch line are typed
// into panes, because commands that arrive over the socket don't run.

import { join, relative } from "@std/path"
import { Fleet, isWorker, needId, opt, root, tmux } from "../fleet.ts"
import * as note from "../note.ts"
import {
  die,
  exists,
  isFile,
  isSocket,
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
import { sync } from "./diff.ts"

const env = (name: string) => Deno.env.get(name) ?? ""
const pad = (text: string, width: number) => text.padEnd(width)

export async function status(fleet: Fleet) {
  const row = (c: string[]) =>
    print(`${pad(c[0], 8)} ${pad(c[1], 10)} ${pad(c[2], 28)} ${pad(c[3], 10)} ${c[4]}`)
  row(["SEAT", "STATE", "TASK", "REPORT", "TODOS"])
  for (const { pane, seat } of await fleet.seats()) {
    const st = await opt(pane, "@agent_state")
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

export function task(fleet: Fleet, args: string[]) {
  const usage = "usage: fleet task <id> [--from <id>] <title>"
  const id = args[0] || die(usage)
  let from = ""
  const words: string[] = []
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--from") {
      from = args[++i] || die("--from needs a task id")
    } else {
      words.push(args[i])
    }
  }
  needId(id)
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
  // a fleet's own guidance/default.md replaces the built-in one
  let guidance = join(root, "guidance", "default.md")
  if (isFile(join(fleet.notes, "guidance", "default.md"))) {
    guidance = join(fleet.notes, "guidance", "default.md")
  }
  // written beside the note and moved into place, so a failed render leaves
  // no half-made note to block a retry
  writeAtomic(
    path,
    readText(join(root, "templates", "task.md"))
      .replaceAll("{{FLEET}}", fleet.name)
      .replaceAll("{{DATE}}", today())
      .replaceAll("{{ID}}", id)
      .replaceAll("{{TITLE}}", words.join(" ") || "untitled")
      .replaceAll("{{GUIDANCE}}", guidance),
  )

  // A follow-up starts from the earlier task's handoff, with its scope and
  // checks, so the new worker needs none of the earlier conversation
  if (from) {
    note.set(path, "follows", from, fleet.name)
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
  await fleet.needSocket(pane)
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

  // base is the worker branch's commit when the task starts, and end is set
  // by `fleet clear`, so `fleet diff` can show this task apart from the
  // branch's earlier and later tasks
  const worktree = fleet.checkout(seat)
  let branch = `worktree-${fleet.name}-${seat}`
  let base = "-"
  if (worktree) {
    if (doSync) await sync(worktree, seat)
    branch = (await output("git", ["-C", worktree, "symbolic-ref", "-q", "--short", "HEAD"])) || branch
    base = await run("git", ["-C", worktree, "rev-parse", "HEAD"])
  }

  // after the update, the worker's branch must contain the earlier task's end
  if (follows && worktree && prevEnd !== "-") {
    if (!(await test("git", ["-C", worktree, "merge-base", "--is-ancestor", prevEnd, "HEAD"]))) {
      die(
        `${seat}'s branch doesn't contain ${follows}'s work (${prevEnd.slice(0, 12)}); assign ${id} to ${
          fleet.seatOf(note.get(prev, "worker"))
        } or merge ${note.get(prev, "branch")} into ${branch} first`,
      )
    }
  }

  note.set(path, "worker", `${fleet.name}-${seat}`, fleet.name)
  note.set(path, "branch", branch, fleet.name)
  note.set(path, "base", base, fleet.name)
  note.set(path, "end", "", fleet.name)
  note.set(path, "status", "assigned", fleet.name)

  // the commit is the baseline that `git diff` in the notes repo compares against
  await fleet.commit(`assign ${id} to ${seat}`)

  await tmux("set", "-p", "-t", pane, "@agent_task", id)
  await tmux("select-pane", "-t", pane, "-T", `${fleet.name}-${seat}: ${id}`)
  await fleet.post(pane, "worker", `Task ${id}: read ${path}`)
}

// Records the task's end at the worktree's HEAD, or `-` in a fleet outside a
// repo, which has no commit to record but closes the task the same way for
// archive, follow-ups and reassign checks
async function close(fleet: Fleet, seat: string, path: string, extra: Record<string, string> = {}) {
  const worktree = fleet.checkout(seat)
  const end = worktree ? await run("git", ["-C", worktree, "rev-parse", "HEAD"]) : "-"
  note.set(path, "end", end, fleet.name)
  note.set(path, "closed", today(), fleet.name)
  for (const [key, value] of Object.entries(extra)) note.set(path, key, value, fleet.name)
  return worktree
}

async function typeClear(pane: string) {
  await tmux("send-keys", "-t", pane, "-l", "/clear")
  await tmux("send-keys", "-t", pane, "Enter")
}

export async function clear(fleet: Fleet, args: string[]) {
  const seat = args[0] || die("seat")
  const pane = await fleet.pane(seat)
  await fleet.needIdle(pane, seat)
  const id = await opt(pane, "@agent_task")
  const path = join(fleet.notes, "tasks", `${id}.md`)
  if (id && isFile(path)) {
    const worktree = fleet.checkout(seat)
    if (worktree && await output("git", ["-C", worktree, "status", "--porcelain"])) {
      warn(
        `${seat} has uncommitted changes; ${id}'s end is its last commit, so they will show in its next task's diff`,
      )
    }
    await close(fleet, seat, path)
  }
  await tmux("set", "-p", "-u", "-t", pane, "@agent_task")
  await tmux("select-pane", "-t", pane, "-T", `${fleet.name}-${seat}`)
  await typeClear(pane)
}

// A seat holding a task keeps it across the restart: the new session gets
// the task line again once its register hook records the socket, and the
// note's base and todos carry the work on. @agent_state `restarting` tells
// the old session's SessionEnd hook not to report the end.
export async function restart(fleet: Fleet, args: string[]) {
  const seat = args[0] || die("seat")
  const pane = await fleet.pane(seat)
  const id = await opt(pane, "@agent_task")
  await tmux("set", "-p", "-t", pane, "@agent_state", "restarting")
  await tmux("set", "-p", "-u", "-t", pane, "@agent_socket")
  await tmux("respawn-pane", "-k", "-t", pane)
  await tmux("set", "-p", "-u", "-t", pane, "@agent_state")
  await tmux("send-keys", "-t", pane, await launchLine(fleet, pane), "Enter")
  if (!id) return
  const path = note.path(fleet.notes, id)
  for (let tries = 0; !isSocket(await opt(pane, "@agent_socket")); tries++) {
    if (tries >= 120) {
      die(
        `${seat} did not start within a minute; it still holds ${id}, so run fleet bump ${id} once it is up`,
      )
    }
    await sleep(500)
  }
  await fleet.post(
    pane,
    "worker",
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
    await close(fleet, seat, path, { status: "abandoned" })
    note.appendLog(
      path,
      `${stamp()} abandoned: closed by ${await fleet.sender()} from seat state ${
        (await opt(pane, "@agent_state")) || "none"
      }`,
    )
  }
  await tmux("set", "-p", "-u", "-t", pane, "@agent_task")
  await tmux("select-pane", "-t", pane, "-T", `${fleet.name}-${seat}`)
  if (isSocket(await opt(pane, "@agent_socket"))) {
    await tmux("send-keys", "-t", pane, "Escape")
    await sleep(500)
    await typeClear(pane)
  } else {
    warn(`${seat} has no live session; fleet restart ${seat} relaunches it`)
  }
  print(`abandoned ${id} on ${seat}`)
}

export async function interrupt(fleet: Fleet, args: string[]) {
  await tmux("send-keys", "-t", await fleet.pane(args[0] || die("seat")), "Escape")
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
  await fleet.post(pane, "worker", `Task ${id} was updated: re-read ${path}`)
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
  await fleet.post(pane, "worker", `Questions in ${id} are answered: re-read ${path}`)
  print(`told ${seat} that ${id}'s questions are answered`)
}

// A worker's report: recorded in the note's status field and Log section,
// and sent to the orchestrator. Only the task's own worker reports on it.
export async function report(fleet: Fleet, args: string[]) {
  const usage = "usage: fleet report <task id> <progress|done|blocked|error> <text>"
  const id = args[0] || die(usage)
  if (args.length < 2) die(usage)
  const phase = args[1]
  if (!["progress", "done", "blocked", "error"].includes(phase)) {
    die(`phase must be progress, done, blocked or error: ${phase}`)
  }
  const text = args.slice(2).join(" ")
  if (!text) die("a report needs a line of text")
  needId(id)
  const path = join(fleet.notes, "tasks", `${id}.md`)
  const { seat, pane } = await fleet.workerOn(id, path)
  if (env("TMUX_PANE") !== pane) die(`only ${seat}, the worker on ${id}, reports on it`)
  if (phase === "done") {
    const [done, total] = await note.progress(root, path)
    if (done !== total) die(`${id} has ${total - done} unchecked todos; check them or report blocked`)
  }
  // find the orchestrator's socket before writing anything, so a report that
  // can't be delivered (the orchestrator mid-/clear) changes nothing and a
  // retry doesn't log the same line twice
  const orch = await fleet.pane("orch")
  await fleet.needSocket(orch)
  note.set(path, "status", phase, fleet.name)
  note.appendLog(path, `${stamp()} ${phase}: ${text}`)
  await fleet.post(orch, "orchestrator", `Report: ${id} ${phase}: ${text}`)
  print(`reported ${id} ${phase} to the orchestrator`)
}
