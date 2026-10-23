# fleet

`fleet` runs a group of Claude Code sessions in one tmux session: one orchestrator and a set of workers. The orchestrator plans with you and hands out tasks. Workers each take one task at a time in their own git worktree. Task state lives in markdown notes on disk. Chat carries only short signals such as `Task T3: read <path>` and `DONE T3`.

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
- A git repository as the working folder, if workers should get worktrees. Outside a repo, every worker shares the folder.

## Concepts

**Fleet.** One tmux session marked with the `@fleet` session option. Window `orch` holds nvim on the fleet's notes folder on the left and the orchestrator on the right. Window `workers` holds the worker panes, tiled. Several fleets can run at once. `fleet ls` lists them.

**Seat.** One pane running one Claude Code session. Seats are named `orch`, `w1`, `w2` and so on. The Claude Code session in seat `w3` of fleet `demo` is named `demo-w3`. That name is the session's [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) address, so the fleet prefix keeps two fleets' orchestrators from claiming each other's workers. The pane title shows the same name.

**Orchestrator.** Plans the work with you, writes task notes, assigns them, and reviews finished work. Its prompt (`prompts/orchestrator.md`) forbids it to implement tasks itself. It drives the workers through the `fleet` command, which its settings allow it to run without prompting.

**Worker.** Takes one task, works its todo list, and reports `DONE` to the orchestrator with `SendMessage`. Each worker runs in [auto mode](https://code.claude.com/docs/en/permission-modes) in its own [git worktree](https://code.claude.com/docs/en/worktrees), on branch `worktree-<fleet>-w<n>`, so workers never share a checkout.

**Task note.** One markdown file per task under `$FLEET_HOME/<fleet>/tasks/<id>.md`, made from `templates/task.md`. The note is the record of the task, with these sections:

- Goal, Scope and Verify: what to do, which files the worker may edit, and how to check the result
- Todo: a checkbox list the worker checks off as it goes
- Questions: decisions the worker needs from you
- Handoff: what the worker wrote when it finished

Decisions go into the note, not chat. That keeps a task's history in one file you can read, edit and diff, and it keeps chat between seats short.

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
4. Creates the tmux session and its two windows. In each seat pane it types a `claude` command with `--name`, `--settings`, `--append-system-prompt-file` and `--add-dir <notes folder>`. Workers also get `--permission-mode` and `-w <seat name>`. See the [CLI reference](https://code.claude.com/docs/en/cli-reference).
5. Opens `nvim .` in the notes folder, in a pane left of the orchestrator. That pane is not a seat, so seat commands and `fleet status` skip it.
6. Turns off `allow-set-title` on each pane, so terminal-title updates from Claude Code or nvim do not replace the pane name.

Claude runs inside the pane's shell. When Claude exits, the pane stays open at a prompt.

### The task loop

1. You agree on work with the orchestrator.
2. The orchestrator runs `fleet task T3 <title>` and fills in the note.
3. The orchestrator runs `fleet assign w2 T3`. `fleet` fills in the note's Worker and Branch lines, commits the notes repo, records `T3` in the seat's `@agent_task` option, and types `Task T3: read <path>` into the seat.
4. The worker works the Todo list and checks items off in the note as it finishes them.
5. When every item is checked, the worker writes Handoff and sends `DONE T3` to the orchestrator.
6. The orchestrator reads the handoff, reviews the branch, reports to you, and runs `fleet clear w2`. That types `/clear` and drops the seat's task, so the next task starts with empty context. Anything the next task needs travels in the notes.

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

Answer by checking an option and then the question line. Then tell the worker it can continue, by typing in its pane or by asking the orchestrator to message it. Nothing notifies the worker when you edit the note.

### Reviewing progress

The notes folder is a git repo, and `fleet assign` commits it before each task starts. `git -C ~/agents/<fleet> diff` shows everything agents have written in the notes since the last assignment. Worker code lives on each worker's branch, so `git log worktree-<fleet>-w2` shows what that worker committed.

### Messaging between seats

Seats on one machine reach each other with Claude Code's [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging). Claude uses the `ListAgents` and `SendMessage` tools, and a message to an idle session starts a turn there. `settings.json` sets [`crossSessionInbound`](https://code.claude.com/docs/en/settings-reference#crosssessioninbound) to `accept`, so no seat holds messages for approval. The orchestrator sets `notify_when_idle` when it messages a worker, so it hears when that worker next goes idle.

Claude Code refuses rapid bursts of messages to one session. The prompts tell seats to send one message per event.

## Commands

| Command | Effect |
| --- | --- |
| `fleet new [name] [dir]` | start a fleet and attach, or attach if it exists |
| `fleet attach [name]` | attach, or switch client when already inside tmux |
| `fleet ls` | list running fleets |
| `fleet kill [name]` | kill the tmux session, by default the fleet that owns the calling pane. Worktrees and notes stay on disk. |
| `fleet clean <name> [--branches]` | remove a stopped fleet's worktrees and state. `--branches` also deletes merged worker branches. |
| `fleet status` | each seat's state, task and todo progress |
| `fleet task <id> <title>` | create a task note and print its path |
| `fleet assign <seat> <id>` | point an idle worker at a task note |
| `fleet clear <seat>` | type `/clear` into an idle seat and drop its task |
| `fleet interrupt <seat>` | send Escape |
| `fleet restart <seat>` | kill the seat's process and relaunch its `claude` command |
| `fleet rename <seat> <title>` | change the pane title |

Seat commands act on the fleet that owns the calling pane, or on the fleet named with `-s <fleet>` placed before the command, such as `fleet -s demo status`.

## Configuration

| Variable | Default | Used by |
| --- | --- | --- |
| `FLEET_HOME` | `~/agents` | notes root |
| `FLEET_WORKERS` | `6` | `fleet new` worker count |
| `FLEET_WORKER_MODE` | `auto` | `fleet new` worker `--permission-mode` |
| `CLAUDE_CONFIG_DIR` | unset | `fleet new` runs every seat's `claude` with it |

### Claude config folder

When `CLAUDE_CONFIG_DIR` is set for `fleet new`, every seat's launch line starts with `CLAUDE_CONFIG_DIR=<dir>`. `fleet restart` reuses the pane's launch line, so a restarted seat keeps the folder. An alias makes a second config folder one command:

```sh
alias fleet-work="CLAUDE_CONFIG_DIR=~/work/.claude fleet"
fleet-work new demo
```

All seats in a fleet use one config folder. `ListAgents` in a session lists only sessions under its own config folder, so a seat on a different folder could not message the rest of the fleet. Claude Code's docs don't state this. It is what `ListAgents` showed on this machine, which had sessions running under two config folders.

Fleet's `--settings` file adds to the config folder's own settings. If that folder's settings set `crossSessionInbound` to `refuse`, deny `SendMessage`, or block auto mode, seats can't message each other or workers can't run unattended. Check them before the first run.

## Permissions and typed input

- **Messages:** a message from another session never counts as your approval and cannot answer a permission prompt ([how a session treats an incoming message](https://code.claude.com/docs/en/cross-session-messaging#how-a-session-treats-an-incoming-message)).
- **Typed input:** `fleet` types into panes with `tmux send-keys`, and Claude Code treats typed input as yours. That is why `fleet` sends only fixed text: `Task <id>: read <path>`, `/clear`, and Escape. Task ids must be letters, digits, `-` and `_`. No `fleet` command passes free text to a pane, so the orchestrator can't use it to answer a worker's permission prompt.
- **Orchestrator allow rules:** its settings allow `fleet status`, `task`, `assign`, `clear`, `interrupt` and `rename`. `fleet new`, `kill` and `restart` still prompt you. See [permissions](https://code.claude.com/docs/en/permissions).
- **Workers:** each worker runs in auto mode, so Claude Code's classifier approves routine actions and you review work through notes and branches.
- **Notes:** every seat may edit files under the fleet's notes folder through an `Edit` allow rule.

## Files

```
bin/fleet                 the command
prompts/orchestrator.md   orchestrator prompt, appended to Claude Code's system prompt
prompts/worker.md         worker prompt, appended to Claude Code's system prompt
templates/task.md         task note template
guidance/default.md       default working rules linked from each note
settings.json             crossSessionInbound and hooks, with {{ROOT}} for this folder
hooks/agent-state         sets @agent_state on the calling pane
hooks/todo-check          Stop hook
hooks/task-progress       counts done todos, total todos and open questions
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

`clean` never touches the notes folder. It is the task record and a git repo of its own, so archive or delete it yourself.

## Limits

These have run only against a stub `claude`, not a live Claude Code session:

- The `Edit(//absolute/path/**)` rule form for the notes folder.
- The `stop_hook_active` input field and the `{"decision": "block"}` output in `hooks/todo-check`.
- `fleet restart` on a worker whose worktree already exists.
- Six worktrees created at once. `git` may contend on its locks, and each new worktree may show a workspace trust prompt.

Other behavior to plan around:

- Claude Code records an appended system prompt when a session starts. Editing `prompts/` affects new seats only. Use guidance files for changes to running work.
- A seat whose `SessionStart` hook never ran stays out of `idle`, and `fleet assign` refuses it. `fleet restart` relaunches it.
- Every message between seats counts toward usage like a prompt you type.

## Related Claude Code features

- [Agent teams](https://code.claude.com/docs/en/agent-teams): a lead session spawns teammates that share a task list, with a tmux split-pane display mode. Teammates are spawned by the lead and talk through team mailboxes. `fleet` instead uses a fixed set of named sessions and plain cross-session messaging.
- [Subagents](https://code.claude.com/docs/en/sub-agents): agents that run inside one session. You can't steer them in their own pane the way you can a seat.
- [Background agents](https://code.claude.com/docs/en/agent-view): sessions started with `claude --bg` and listed by `claude agents`.
