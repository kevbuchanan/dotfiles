# fleet

`fleet` runs a group of Claude Code sessions in one tmux session: one orchestrator and a set of workers. The orchestrator plans with you and hands out tasks. Workers each take one task at a time in their own git worktree. Task state lives in markdown notes on disk. Messages between seats carry only short signals, such as `Task T3: read <path>` and `Report: T3 done: <summary>`.

```sh
cd ~/code/some-repo
fleet new demo          # tmux session "demo": orchestrator + 6 workers
fleet status            # from any pane in the fleet
fleet kill demo
```

## Requirements

- tmux with the `allow-set-title` pane option. Tested with tmux 3.6a.
- Claude Code 2.1.224 or later on macOS or Linux, for [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- `jq` and `git` on PATH
- [diffview.nvim](https://github.com/sindrets/diffview.nvim), optional, for `:FleetDiff`
- A git repository as the working folder, if workers should get worktrees. Outside a repo, every worker shares the folder.

## Concepts

**Fleet.** One tmux session marked with the `@fleet` session option. Window `orch` holds nvim on the fleet's notes folder on the left and the orchestrator on the right. Window `workers` holds the worker panes, tiled. Several fleets can run at once. `fleet ls` lists them, along with stopped fleets that still have files on disk.

**Seat.** One pane running one Claude Code session. Seats are named `orch`, `w1`, `w2` and so on. The Claude Code session in seat `w3` of fleet `demo` is named `demo-w3`. That name is the session's [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) address, so the fleet prefix keeps two fleets' orchestrators from claiming each other's workers. The pane title shows the same name.

**Orchestrator.** Plans the work with you, writes task notes, assigns them, and reviews finished work. Its skill, `fleet:orchestrator`, forbids it to implement tasks itself. It drives the workers through the `fleet` command, which its settings allow it to run without prompting.

**Worker.** Takes one task, works its todo list, and reports to the orchestrator with `fleet report`. Each worker runs in [auto mode](https://code.claude.com/docs/en/permission-modes) in its own [git worktree](https://code.claude.com/docs/en/worktrees), on branch `worktree-<fleet>-w<n>`, so workers never share a checkout.

**Task note.** One markdown file per task under `$FLEET_HOME/<fleet>/tasks/<id>.md`, made from `templates/task.md`. The note is the record of the task, with these sections:

- header fields: Guidance, Follows for a follow-up task, Worker, Branch, and the Base and End commits that bound this task's changes on the worker's branch
- Goal, Scope and Verify: what to do, which files the worker may edit, and how to check the result
- Todo: a checkbox list the worker checks off as it goes
- Questions: decisions the worker needs from you
- Handoff: what the worker wrote when it finished

Decisions go into the note, not chat. That keeps a task's history in one file you can read, edit and diff, and it keeps chat between seats short.

**Skills.** The protocol each seat follows lives in two [skills](https://code.claude.com/docs/en/skills), `fleet:orchestrator` and `fleet:worker`, in a plugin under `plugin/` that every seat loads with `--plugin-dir`. Each launch prompt in `prompts/` only names the seat, the fleet and its notes folder, and points at the skill. Every fleet message ends its first line with `(handle per /fleet:worker skill)` or the orchestrator equivalent. A seat reads the skill when it uses it, so an edit to a skill reaches running seats from their next message, without a restart. Loading the plugin with `--plugin-dir` works under any config folder.

**Guidance.** A markdown file of working rules that a task note links on its `Guidance:` line. `guidance/default.md` is the starting set. Workers re-read the note before each todo item, so an edit to the note or its guidance applies from the worker's next item. Write a new guidance file to try a different process on one task without changing the prompts.

**Seat state.** Hooks set the `@agent_state` pane option. The pane border and `fleet status` show it.

| State | Set when |
| --- | --- |
| `idle` | the session starts, or a turn ends with nothing left to do |
| `busy` | a prompt is submitted, or a tool call finishes |
| `waiting` | Claude Code shows a permission prompt or another question in the pane |
| `question` | a turn ends with an open question in the task note |
| `stalled` | a turn ends twice in a row with unchecked todos |

`fleet assign` and `fleet clear` act only on an `idle` seat.

## How it works

### Starting a fleet

`fleet new [name] [dir]` does the following:

1. Creates `$FLEET_HOME/<name>/` as a git repo for task notes, if it does not exist yet.
2. Renders each seat's prompt from `prompts/` into `~/.local/state/fleet/<name>/`, filling in the names of the fleet, the seat, the orchestrator and the workers. In a git repo, it also records the repo's root there for `fleet clean`.
3. Renders two settings files from `settings.json`. Both enable the hooks and allow edits under the notes folder. The orchestrator's file also allows the per-seat `fleet` commands.
4. Creates the tmux session and its two windows. In each seat pane it types a `claude` command with `--name`, `--settings`, `--append-system-prompt-file`, `--add-dir <notes folder>` and `--plugin-dir <fleet>/plugin`. Workers also get `--permission-mode` and `-w <seat name>`. See the [CLI reference](https://code.claude.com/docs/en/cli-reference).
5. Opens `nvim .` in the notes folder, in a pane left of the orchestrator. That pane is not a seat, so seat commands and `fleet status` skip it.
6. Turns off `allow-set-title` on each pane, so terminal-title updates from Claude Code or nvim do not replace the pane name.

Claude runs inside the pane's shell. When Claude exits, the pane stays open at a prompt.

### The task loop

1. You agree on work with the orchestrator.
2. The orchestrator runs `fleet task T3 <title>` and fills in the note.
3. The orchestrator runs `fleet assign w2 T3`. `fleet` fills in the note's Worker and Branch lines, records the worker branch's current commit as Base, commits the notes repo, records `T3` in the seat's `@agent_task` option, and types `Task T3: read <path>` into the seat.
4. The worker works the Todo list and checks items off in the note as it finishes them.
5. When every item is checked, the worker writes Handoff and runs `fleet report T3 done "<summary>"`.
6. The orchestrator reads the handoff, reviews the task with `fleet diff T3`, reports to you, and runs `fleet clear w2`. That records the worker branch's commit as the note's End, types `/clear` and drops the seat's task, so the next task starts with empty context. Anything the next task needs travels in the notes.

### The todo check

The `Stop` hook (`hooks/todo-check`) reads the seat's current task note when Claude ends a turn.

- With unchecked todos and no open question, it blocks the stop and tells Claude how many items remain. See [hooks](https://code.claude.com/docs/en/hooks).
- If Claude stops again straight after that, the hook lets the stop through and marks the seat `stalled`. Blocking only once means a confused worker can't loop forever. The orchestrator checks stalled seats.
- With an open question, the stop goes through and the seat shows `question`.

`hooks/task-progress` counts only top-level checkbox lines under `## Todo` and `## Questions`. `fleet status` uses it too.

### Questions

A worker that needs a decision writes it in the note and stops:

```md
## Questions

- [ ] Q1: Which session store?
  - [ ] Redis
  - [ ] Postgres
```

The worker also runs `fleet report T3 blocked "<the question>"`, so the orchestrator hears about it. Answer by checking an option and then the question line. The worker has stopped and gets no new turn until a message arrives, so tell it:

- `fleet answer T3` sends `Questions in T3 are answered: re-read <path>` to the worker. It refuses unless the worker is still on T3, its seat is in state `question`, and no question in the note is left open.
- In nvim, saving a task note runs `fleet answer` for it. Answering in the notes pane and saving is enough. A save that doesn't meet those conditions does nothing and shows nothing, so ordinary edits are unaffected.

The orchestrator may run `fleet answer` too. Edits made outside nvim need `fleet answer` by hand.

### Follow-up work

Where follow-up goes depends on whether the worker has been cleared from the task.

**Before `fleet clear`:** the worker still has the task and its context. Add unchecked items to the note's Todo list, then wake the worker:

- `fleet bump T3` sends `Task T3 was updated: re-read <path>` to the worker. It refuses unless the worker is still on T3. A stopped worker starts a turn when the message arrives, and a busy one reads it between tool calls, so the seat's state doesn't matter.
- `:FleetBump` in nvim saves the note and bumps its worker. `<Leader>b` runs it. With a task id, `:FleetBump T3` works from any buffer inside a fleet.

The worker works the new items, updates Handoff and reports `done` again. Saving a note does not bump the worker, because a save often comes mid-edit. Bump once the follow-up is written.

**After `fleet clear`:** the task is closed. Its End is recorded and its worker's context is gone. Put follow-up in a new task that starts from the closed one:

- `fleet task T3-2 --from T3` creates T3-2 with `Follows: T3` in its header, T3's Scope and Verify sections, and a Goal that links T3's note and says to read its Handoff first. A title after the id replaces the default `follow-up to T3`.
- `:FleetFollowUp` in nvim, run from T3's note, does the same and opens the new note. It picks the next free numbered id, `T3-2` after `T3` and `T3-3` after `T3-2`, and takes an id and title as arguments too.
- Fill in the new Todo list and assign it. The follow-up gets a fresh context and its own Base and End, so `fleet diff T3` and `fleet diff T3-2` each show one round, and the `Follows:` lines chain the rounds.

A follow-up builds on the earlier task's code, so `fleet assign` checks that the worker's branch already contains the earlier task's End commit. If it doesn't, assign refuses and names the two ways out: assign to the earlier task's worker, or merge the earlier task's branch into this worker's branch first. It also refuses a follow-up to a task that is still open; add the work to that task and bump it.

`fleet assign` refuses a task that already has an End: reassigning it would overwrite Base, and `fleet diff T3` would lose the closed work.

fleet has no command that reopens a closed task with its old conversation. The handoff carries what the follow-up needs.

The orchestrator owns follow-up. Tell it what's needed, and it writes the items into the note and bumps the worker, so the decision lands in the note and not only in chat.

### Working in a worker's checkout

Each worker's Claude session runs in its worktree, `<repo>/.claude/worktrees/<fleet>-w<n>`. The pane's shell does not: it starts in the repo root, because `-w` moves only Claude's own working folder.

- `fleet path w2` prints the worktree path, such as `cd "$(fleet path w2)"` in a shell or ``:e `fleet path w2`/docs/design.md`` in nvim.
- `fleet shell w2` opens a tmux window named `w2-shell` in the worktree and switches to it. `fleet shell w2 nvim .` opens an editor there, and any other command works the same way. The window is not a seat, so `fleet status` and the seat commands skip it. Running `fleet shell w2` again switches to the open window.
- `:Prose <fleet>-w2` in nvim, on a file in that worktree, opens a [prose](../prose/README.md) review whose comments go to that worker.

Typing `! <command>` in a worker's Claude pane also runs a command in its worktree, but the output becomes part of that worker's conversation and uses context it needs for its task. `fleet shell` keeps your inspection out of the worker's context.

Both commands need the repo record that `fleet new` writes for a fleet started in a git repo, and the worktree must exist. Claude Code creates it when the worker's session starts.

### Reviewing progress

The notes folder is a git repo, and `fleet assign` commits it before each task starts. `git -C ~/agents/<fleet> diff` shows everything agents have written in the notes since the last assignment.

Worker code lives on each worker's branch. A worker keeps its branch across tasks, so the branch holds every task that worker has done. The note's Base and End fields mark one task's part of it: `fleet assign` records Base, and `fleet clear` records End.

- `fleet diff T3` shows task T3's changes. While T3 is still its seat's current task, the diff runs in the worktree from Base, so it includes edits the worker hasn't committed. Untracked new files don't show until the worker commits them. After `fleet clear`, it is `Base..End`, so later tasks on the same branch stay out of it. Other arguments go to `git diff`, such as `fleet diff T3 --stat`.
- `:FleetDiff T3` in nvim opens the same diff in [diffview.nvim](https://github.com/sindrets/diffview.nvim), one tab with a file list. Run from a task note, such as in the notes pane, `:FleetDiff` with no argument and `<Leader>d` use that note's task. Task ids complete from the notes folder.
- `git diff main...worktree-<fleet>-w2` from any checkout shows everything a worker has committed since its branch left `main`. Worktrees share the repo's git database, so worker branches are visible everywhere.

A task assigned before fleet recorded Base has none, and `fleet diff` says so. A seat restarted with `fleet restart` drops its task without recording End. `fleet diff` then shows the task through the branch's latest commit and prints a warning.

### Reports

A worker reports on its task with `fleet report <id> <phase> "<one line>"`, where the phase is `progress`, `done`, `blocked` or `error`. fleet:

1. refuses unless the calling pane is the task's worker, and refuses `done` while the note has unchecked todos
2. writes the phase to the note's `Status:` field and appends a dated line to a `## Log` section at the end of the note
3. sends `Report: <id> <phase>: <text>` to the orchestrator, whose skill says what to do for each phase

`fleet status` shows each seat's latest report in its REPORT column. Workers may run `fleet report` without prompting.

### Messaging between seats

fleet sends every task message, `assign`, `bump`, `answer` and `report`, to the receiving seat's Claude Code [inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket), the same channel cross-session messaging uses. Claude Code exports each session's socket path to hooks as `CLAUDE_CODE_MESSAGING_SOCKET`, and the `SessionStart` hook `hooks/register` records it on the seat's pane as `@agent_socket`. It runs again after `/clear` and on restart. A message to an idle session starts a turn there, and a busy session reads it between tool calls.

Each message's first line names its sender and the skill that handles it:

```
From fleet, sent by the orchestrator shop-orch (handle per /fleet:worker skill):
Task pay-1022-retry-queue: read ~/agents/shop/tasks/pay-1022-retry-queue.md
```

The sender is the seat of the calling pane, or `the user` from any other shell. `settings.json` sets [`crossSessionInbound`](https://code.claude.com/docs/en/settings-reference#crosssessioninbound) to `accept`, so no seat holds these messages for approval. Seats can still message each other directly with `SendMessage`, but the skills route task traffic through fleet, so it lands in the notes.

A seat started before fleet recorded sockets has no `@agent_socket`, and fleet refuses to message it until `fleet restart` relaunches it. `fleet assign` checks for the socket before it changes anything.

### Pane titles

A worker's pane title is its session name plus its current task, such as `shop-w2: pay-1022-retry-queue`. `fleet assign` sets it, and `fleet clear` and `fleet restart` set it back to the session name.

Claude Code refuses rapid bursts of messages to one session. The prompts tell seats to send one message per event.

## Commands

| Command | Effect |
| --- | --- |
| `fleet new [name] [dir]` | start a fleet and attach, or attach if it exists |
| `fleet attach [name]` | attach, or switch client when already inside tmux |
| `fleet ls` | list running fleets, and stopped fleets `fleet clean` hasn't removed, with each one's repo, notes folder and worktree count |
| `fleet kill [name]` | kill the tmux session, by default the fleet that owns the calling pane. Worktrees and notes stay on disk. |
| `fleet clean <name> [--branches]` | remove a stopped fleet's worktrees and state. `--branches` also deletes merged worker branches. |
| `fleet status` | each seat's state, task and todo progress |
| `fleet task <id> [--from <id>] <title>` | create a task note and print its path. `--from` starts a follow-up to a closed task. |
| `fleet assign <seat> <id>` | point an idle worker at a task note |
| `fleet clear <seat>` | type `/clear` into an idle seat and drop its task |
| `fleet interrupt <seat>` | send Escape |
| `fleet restart <seat>` | kill the seat's process and relaunch its `claude` command |
| `fleet rename <seat> <title>` | change the pane title |
| `fleet path <seat>` | print a worker's worktree path |
| `fleet answer <id>` | tell a worker waiting on a question that the task's questions are answered |
| `fleet report <id> <phase> <text>` | a worker's report on its task: `progress`, `done`, `blocked` or `error` |
| `fleet bump <id>` | tell the worker still on the task that its note has new work |
| `fleet diff [--rev] <id> [git diff args]` | show one task's changes. `--rev` prints the folder and revision `:FleetDiff` uses. |
| `fleet shell <seat> [cmd]` | open window `<seat>-shell` in a worker's worktree, running `cmd` or a shell |

Seat commands act on the fleet that owns the calling pane, or on the fleet named with `-s <fleet>` placed before the command, such as `fleet -s demo status`.

## Configuration

| Variable | Default | Used by |
| --- | --- | --- |
| `FLEET_HOME` | `~/agents` | notes root |
| `FLEET_WORKERS` | `6` | `fleet new` worker count |
| `FLEET_WORKER_MODE` | `auto` | `fleet new` worker `--permission-mode` |
| `CLAUDE_CONFIG_DIR` | unset | `fleet new` runs every seat's `claude` with it |
| `FLEET_ORCH_MODEL` | unset | `fleet new` orchestrator `--model` |
| `FLEET_WORKER_MODEL` | unset | `fleet new` worker `--model` |
| `FLEET_ORCH_EFFORT` | unset | `fleet new` orchestrator `--effort`: `low`, `medium`, `high`, `xhigh` or `max` |
| `FLEET_WORKER_EFFORT` | unset | `fleet new` worker `--effort` |

### Models and effort

Unset, every seat uses its config folder's default model: `ANTHROPIC_MODEL` if that is set, otherwise the `model` setting. The four variables above set the orchestrator and the workers separately. The orchestrator plans and reviews, and the workers carry out narrower tasks, so a strong model for one seat and a cheaper one for the rest is a common split:

```sh
FLEET_ORCH_MODEL=opus FLEET_WORKER_MODEL=sonnet FLEET_WORKER_EFFORT=medium fleet new demo
```

An alias such as `opus` or `sonnet` resolves through the config folder's `ANTHROPIC_DEFAULT_OPUS_MODEL` and `ANTHROPIC_DEFAULT_SONNET_MODEL` when they are set, so the same command works under any config folder. A full model id works too. The flags are part of each seat's launch line, so `fleet restart` keeps them. `/model` in a seat's pane changes that session only, until it restarts.

### Claude config folder

When `CLAUDE_CONFIG_DIR` is set for `fleet new`, every seat's launch line starts with `CLAUDE_CONFIG_DIR=<dir>`. `fleet restart` reuses the pane's launch line, so a restarted seat keeps the folder. An alias makes a second config folder one command:

```sh
alias fleet-work="CLAUDE_CONFIG_DIR=~/work/.claude fleet"
fleet-work new demo
```

All seats in a fleet use one config folder. `ListAgents` in a session lists only sessions under its own config folder, so a seat on a different folder could not message the rest of the fleet. Claude Code's docs don't state this. It is what `ListAgents` showed on this machine, which had sessions running under two config folders.

Fleet's `--settings` file adds to the config folder's own settings. If that folder's settings set `crossSessionInbound` to `refuse` or block auto mode, seats don't receive fleet's messages or workers can't run unattended. Check them before the first run.

## Permissions and typed input

- **Messages:** task messages arrive over the inbox socket, and Claude Code treats a message from another session as never counting as your approval. It cannot answer a permission prompt ([how a session treats an incoming message](https://code.claude.com/docs/en/cross-session-messaging#how-a-session-treats-an-incoming-message)).
- **Typed input:** `fleet` still types three things into panes with `tmux send-keys`: the launch line, `/clear` and Escape. Commands sent over the socket arrive as plain text and don't run, so `/clear` has to be typed. Claude Code treats typed input as yours, so `clear` and `interrupt` send only that fixed text, and `clear` acts only on an `idle` seat. Task ids must be letters, digits, `-` and `_`.
- **Orchestrator allow rules:** its settings allow `fleet status`, `task`, `assign`, `clear`, `interrupt`, `rename`, `path`, `diff`, `answer` and `bump`. Workers' settings allow `fleet report`. `fleet new`, `kill`, `restart`, `clean` and `shell` still prompt you, so the orchestrator can't open windows on its own. See [permissions](https://code.claude.com/docs/en/permissions).
- **Workers:** each worker runs in auto mode, so Claude Code's classifier approves routine actions and you review work through notes and branches.
- **Notes:** every seat may edit files under the fleet's notes folder through an `Edit` allow rule.

## Files

```
bin/fleet                 the command
prompts/orchestrator.md   orchestrator identity, appended to Claude Code's system prompt
prompts/worker.md         worker identity, appended to Claude Code's system prompt
plugin/                   the fleet plugin: skills/orchestrator and skills/worker
templates/task.md         task note template
guidance/default.md       default working rules linked from each note
settings.json             crossSessionInbound and hooks, with {{ROOT}} for this folder
hooks/agent-state         sets @agent_state on the calling pane
hooks/register            SessionStart hook: records the session's inbox socket
hooks/todo-check          Stop hook
hooks/task-progress       counts done todos, total todos and open questions
nvim/plugin/fleet.lua     :FleetDiff and <Leader>d, linked into ~/.config/nvim/plugin
```

Run state lives outside this folder:

- `~/.local/state/fleet/<fleet>/`: rendered prompts and settings, and the repo root. `XDG_STATE_HOME` moves it. Seats read these files at every launch, including `fleet restart`, so they don't go in `$TMPDIR`, where macOS deletes files nobody has opened for a few days.
- `$FLEET_HOME/<fleet>/`: task notes
- `<repo>/.claude/worktrees/<fleet>-w<n>/`: worker checkouts

### Cleaning up

`fleet kill` stops the tmux session and leaves everything on disk, so a stuck fleet can be killed without losing work. `fleet clean <name>` removes what a stopped fleet left behind:

1. It refuses while a tmux session with that name exists.
2. It runs `git worktree remove` on each worker worktree. Git refuses a worktree with uncommitted or untracked changes, and `clean` keeps it and reports it.
3. With `--branches`, it runs `git branch -d` on the branch of each removed worktree. Git refuses a branch that is not merged, so unmerged commits stay on their branch.
4. It deletes `~/.local/state/fleet/<fleet>/`, unless it kept a worktree. The recorded repo root lets a rerun find the kept worktrees.

`fleet ls` shows what is left to clean. A stopped fleet stays in the list until `fleet clean` removes its state folder. The WORKTREES column counts the worker worktrees still in the repo:

```
FLEET                STATE    WORKTREES REPO                                     NOTES
api                  running  6         ~/code/api                               ~/agents/api
docs                 stopped  2         ~/code/docs                              ~/agents/docs
```

A fleet started before fleet kept a repo record shows `-` for its repo and worktrees, and `fleet clean` can't find its worktrees. Remove them with `git worktree remove`.

`clean` never touches the notes folder. It is the task record and a git repo of its own, so archive or delete it yourself.

## Limits

These have run only against a stub `claude`, not a live Claude Code session:

- The `Edit(//absolute/path/**)` rule form for the notes folder.
- The `stop_hook_active` input field and the `{"decision": "block"}` output in `hooks/todo-check`.
- `fleet restart` on a worker whose worktree already exists.
- Six worktrees created at once. `git` may contend on its locks, and each new worktree may show a workspace trust prompt.

Other behavior to plan around:

- Claude Code records an appended system prompt when a session starts, so editing `prompts/` affects new seats only. Those files hold only each seat's identity. The protocol is in the skills, which running seats re-read.
- A seat whose `SessionStart` hook never ran stays out of `idle`, and `fleet assign` refuses it. `fleet restart` relaunches it.
- Every message between seats counts toward usage like a prompt you type.

## Related Claude Code features

- [Agent teams](https://code.claude.com/docs/en/agent-teams): a lead session spawns teammates that share a task list, with a tmux split-pane display mode. Teammates are spawned by the lead and talk through team mailboxes. `fleet` instead uses a fixed set of named sessions and plain cross-session messaging.
- [Subagents](https://code.claude.com/docs/en/sub-agents): agents that run inside one session. You can't steer them in their own pane the way you can a seat.
- [Background agents](https://code.claude.com/docs/en/agent-view): sessions started with `claude --bg` and listed by `claude agents`.
