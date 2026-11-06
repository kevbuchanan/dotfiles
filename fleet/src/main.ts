// fleet: Claude Code fleets in tmux. See USAGE, and README.md beside src/.

import { Fleet, isFleet } from "./fleet.ts"
import { archive, migrate } from "./cmd/archive.ts"
import { diff } from "./cmd/diff.ts"
import { attach, clean, create, kill, ls } from "./cmd/lifecycle.ts"
import * as seat from "./cmd/seat.ts"
import { die, FleetError } from "./run.ts"

const USAGE = `fleet: Claude Code fleets in tmux. Each fleet is one tmux session with an
orchestrator seat in window \`orch\`, worker seats w1..wN in window
\`workers\`, and a shell in the project folder in window \`shell\`. Seats
share task notes in $FLEET_HOME/<fleet>/tasks, a git repo, so \`git diff\`
there shows what agents wrote since the last assignment.

  fleet new [name] [dir] [--workers N] [--worker-mode M]
            [--orch-model M] [--worker-model M] [--orch-effort E] [--worker-effort E]
                               start a fleet and attach to it; each flag
                               overrides the FLEET_* variable of that name
  fleet attach [name]
  fleet ls                     running fleets, and stopped fleets that
                               \`fleet clean\` has not removed
  fleet migrate [--dry-run]    convert old-format notes to frontmatter
  fleet archive [--dry-run]    move closed, shipped-or-unshipped task notes
                               that no open task links into tasks/archive
  fleet kill [name]            default: the calling pane's fleet; worktrees
                               and notes stay on disk
  fleet clean <name> [--branches]
                               remove a stopped fleet's clean worktrees and
                               its state; --branches also deletes merged
                               worker branches
  fleet status
  fleet task <id> [--from <id>] <title>
                               create a task note and print its path;
                               --from starts a follow-up to a closed task
  fleet assign [--no-sync] <seat> <id>
                               point an idle worker at a task note, first
                               bringing its branch up to date with the
                               default branch
  fleet clear <seat>           /clear an idle seat and drop its task
  fleet interrupt <seat>       send Escape to the seat
  fleet restart <seat>         kill the seat's process and relaunch claude;
                               a seat on a task keeps it
  fleet abandon <seat>         close the seat's task from any state and
                               clear the seat
  fleet rename <seat> <title>
  fleet path <seat>            print a worker's worktree path
  fleet answer <id>            tell a worker waiting in state \`question\`
                               that its task's questions are answered
  fleet bump <id>              tell the worker still on a task that its
                               note has new work
  fleet report <id> <phase> <text>
                               a worker's report on its task: progress,
                               review, done, blocked or error
  fleet diff [--rev] [<task id> | <seat>] [git diff args]
                               one task's changes, or a worker's whole
                               branch; with neither, the calling worker's
                               branch. --rev prints the folder and revision
                               instead, for :FleetDiff
  fleet shell <seat> [cmd]     open a window in a worker's worktree, running
                               cmd or a shell
  fleet pair <task id | seat>  open a window in a task's checkout with nvim
                               and an interactive claude that has read the
                               task's note

Seat commands act on the fleet named by -s <fleet>, or else on the fleet
that owns the calling pane.

Task messages (assign, bump, answer, report) go to a seat's Claude Code
inbox socket, which the register hook records on its pane. Claude Code
treats them as messages from another session: they can't approve a
permission prompt, and a busy session reads them between tool calls. Only
/clear, Escape and the launch line are typed into panes, because commands
that arrive over the socket don't run. Each message starts with a line
naming its sender and the skill that handles it.

FLEET_HOME          notes root, default ~/agents
XDG_STATE_HOME      fleet state goes in $XDG_STATE_HOME/fleet/<fleet>,
                    default ~/.local/state/fleet/<fleet>
FLEET_WORKERS       worker count for \`new\`, default 6
FLEET_WORKER_MODE   worker --permission-mode for \`new\`, default auto
CLAUDE_CONFIG_DIR   if set for \`new\`, every seat runs claude with it
FLEET_ORCH_MODEL, FLEET_WORKER_MODEL
                    --model for the orchestrator and for every worker
FLEET_ORCH_EFFORT, FLEET_WORKER_EFFORT
                    --effort for each role: low, medium, high, xhigh or max
                    Unset leaves the config dir's default model and effort.`

// commands that act on one running fleet, given by -s or the calling pane
const SEAT_COMMANDS: Record<string, (fleet: Fleet, args: string[]) => Promise<void> | void> = {
  status: (fleet) => seat.status(fleet),
  task: seat.task,
  assign: seat.assign,
  clear: seat.clear,
  interrupt: seat.interrupt,
  restart: seat.restart,
  abandon: seat.abandon,
  rename: seat.rename,
  path: seat.path,
  shell: seat.shell,
  pair: seat.pair,
  bump: seat.bump,
  answer: seat.answer,
  report: seat.report,
  diff,
  archive,
  migrate,
}

async function main(argv: string[]) {
  let name = ""
  if (argv[0] === "-s") {
    name = argv[1] || die("fleet name")
    argv = argv.slice(2)
  }
  const [cmd = "help", ...args] = argv
  if (Object.hasOwn(SEAT_COMMANDS, cmd)) return await SEAT_COMMANDS[cmd](await Fleet.current(name), args)
  switch (cmd) {
    case "new":
      return await create(args)
    case "attach": {
      name = args[0] || name || die("usage: fleet attach <name>")
      if (!(await isFleet(name))) die(`${name} is not a fleet`)
      return await attach(name)
    }
    case "ls":
      return await ls()
    case "kill":
      return await kill(await Fleet.current(args[0] || name))
    case "clean":
      return await clean(args)
    default:
      console.log(USAGE)
      if (cmd !== "help") Deno.exit(1)
  }
}

try {
  await main(Deno.args)
} catch (e) {
  if (!(e instanceof FleetError)) throw e
  console.error(`fleet: ${e.message}`)
  Deno.exit(e.code)
}
