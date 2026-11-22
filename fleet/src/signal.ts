// What a seat's agent tells fleet about its session: it started, it stopped,
// it ended. Each agent reports these its own way, Claude Code through hooks
// that run `fleet signal`, and fleet keeps the seat's state and the
// orchestrator's notices here, the same for every agent.

import { join } from "@std/path"
import { Fleet, isFleet, isWorker, opt, readState, root, setOpt, setState, unsetOpt } from "./fleet.ts"
import * as note from "./note.ts"
import { die, FleetError, isFile, output } from "./run.ts"
import { asPane, oneOf, type Pane } from "./types.ts"

// How fleet reaches a session: an inbox socket, for an agent that has one, or
// the agent's id for it, for one fleet reaches by id
export type Reach = { socket?: string; session?: string }

// The session in pane started, after a launch, a restart or a context reset
export async function started(pane: Pane, reach: Reach = {}) {
  if (reach.socket) await setOpt(pane, "@agent_socket", reach.socket)
  if (reach.session) await setOpt(pane, "@agent_session", reach.session)
  await setState(pane, "idle")
}

// The agent finished a turn. While the pane's task note has unchecked todos
// and no open question, the first stop sends it back to the list: the
// returned text is what to tell it. A second stop in a row, again, is let
// through and marked stalled, and the orchestrator gets a notice. A stop
// while the agent still has work running in the background, such as
// subagents it is waiting on, is neither: the agent ends its turn to wait,
// and the work's result starts the next one. background answers that, and
// runs only when the task has todos left.
export async function stopped(
  fleet: Fleet,
  pane: Pane,
  again: boolean,
  background: () => Promise<boolean> = () => Promise.resolve(false),
): Promise<string> {
  const task = await opt(pane, "@agent_task")
  const path = task ? join(fleet.notes, "tasks", `${task}.md`) : ""
  if (!path || !isFile(path)) {
    await setState(pane, "idle")
    return ""
  }
  const [checked, total, open] = await note.progress(root, path)
  if (open > 0) {
    await setState(pane, "question")
  } else if (checked < total) {
    const left = total - checked
    if (await background()) {
      await setState(pane, "busy")
    } else if (again) {
      await setState(pane, "stalled")
      await notice(
        fleet,
        pane,
        `${task} stalled: the worker stopped twice with ${left} unchecked todos and no open question in ${path}.`,
      )
    } else {
      await setState(pane, "busy")
      return `${task} has ${left} unchecked todos in ${path}. Re-read the note and continue with the next item. If you are blocked, add a question under ## Questions, run fleet report ${task} blocked with the question, and stop.`
    }
  } else {
    await setState(pane, "idle")
  }
  return ""
}

// The session in pane ended. A worker that still holds a task tells the
// orchestrator, since the note stays open with nobody working it. `fleet
// clear` drops the task before its reset and `fleet restart` marks the pane
// restarting, so neither sends a notice.
export async function ended(fleet: Fleet, pane: Pane, reason: string) {
  const task = await opt(pane, "@agent_task")
  if (task && (await readState(pane)) !== "restarting") {
    await notice(
      fleet,
      pane,
      `${task}: the worker's session ended (${
        reason || "other"
      }) while it held the task. The note is still open. fleet restart relaunches the seat with the task; fleet abandon closes it.`,
    )
  }
  await unsetOpt(pane, "@agent_state")
  await unsetOpt(pane, "@agent_socket")
  await unsetOpt(pane, "@agent_session")
}

// A notice from a worker's pane to the orchestrator, for what the worker
// can't report itself. It is dropped while the fleet stops, and when it
// can't be delivered: the orchestrator also sees the seat's state in `fleet
// status`.
async function notice(fleet: Fleet, from: Pane, text: string) {
  if (!isWorker(await opt(from, "@agent_seat"))) return
  if (await output("tmux", ["show", "-qv", "-t", fleet.target, "@fleet_stopping"])) return
  try {
    await fleet.post({ pane: await fleet.pane("orch"), skill: "orchestrator" }, `Notice: ${text}`, from)
  } catch (e) {
    if (!(e instanceof FleetError)) throw e
  }
}

// fleet signal <start|busy|waiting|stop|end> [--pane <id>] [--socket <path>]
// [--again] [--transcript <path>] [--reason <text>]: the pane defaults to
// $TMUX_PANE. --transcript is the agent's record of the session, which its
// adapter reads for background work still running. A pane in no
// fleet is left alone, so an agent's hooks can call this in any session.
const EVENTS = ["start", "busy", "waiting", "stop", "end"] as const

export async function signal(args: string[]) {
  const usage =
    "usage: fleet signal <start|busy|waiting|stop|end> [--pane <id>] [--socket <path>] [--again] [--transcript <path>] [--reason <text>]"
  const event = args[0] ?? ""
  if (!oneOf(EVENTS, event)) die(usage)
  let given = Deno.env.get("TMUX_PANE") ?? ""
  let socket = ""
  let reason = ""
  let again = false
  let transcript = ""
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a === "--pane") given = args[++i] || die("--pane needs a pane id")
    else if (a === "--socket") socket = args[++i] ?? ""
    else if (a === "--reason") reason = args[++i] ?? ""
    else if (a === "--again") again = true
    else if (a === "--transcript") transcript = args[++i] ?? ""
    else die(usage)
  }
  if (!given) return
  const pane = asPane(given)
  const name = await output("tmux", ["display", "-p", "-t", pane, "#S"])
  if (!name || !(await isFleet(name))) return
  const fleet = await Fleet.current(name)
  switch (event) {
    case "start":
      return await started(pane, { socket })
    case "busy":
    case "waiting":
      return await setState(pane, event)
    case "stop": {
      const reply = await stopped(fleet, pane, again, () => fleet.agent.backgroundWork(pane, transcript))
      if (reply) console.log(reply)
      return
    }
    case "end":
      return await ended(fleet, pane, reason)
  }
}
