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

**Fleet.** One tmux session marked with the `@fleet` session option. Window `orch` holds nvim on the fleet's notes folder on the left and the orchestrator on the right. Window `workers` holds the worker panes, tiled. Several fleets can run at once. `fleet ls` lists them, along with stopped fleets that still have files on disk. A fleet's name becomes its tmux session, notes folder and state folder, so it may use only letters, digits, `-` and `_`. `fleet new` refuses anything else, such as a path.

**Seat.** One pane running one Claude Code session. Seats are named `orch`, `w1`, `w2` and so on. The Claude Code session in seat `w3` of fleet `demo` is named `demo-w3`. That name is the session's [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) address, so the fleet prefix keeps two fleets' orchestrators from claiming each other's workers. The pane title shows the same name.

**Orchestrator.** Plans the work with you, writes task notes, assigns them, and reviews finished work. Its skill, `fleet:orchestrator`, forbids it to implement tasks itself. It drives the workers through the `fleet` command, which its settings allow it to run without prompting.

**Worker.** Takes one task, works its todo list, and reports to the orchestrator with `fleet report`. Each worker runs in [auto mode](https://code.claude.com/docs/en/permission-modes) in its own [git worktree](https://code.claude.com/docs/en/worktrees), on branch `worktree-<fleet>-w<n>`, so workers never share a checkout.

**Task note.** One markdown file per task under `$FLEET_HOME/<fleet>/tasks/<id>.md`, made from `templates/task.md`. The note is the record of the task, with these sections:

- YAML frontmatter with the task's fields, one `key: value` per line: `fleet` and `task`, which name the note's fleet and id; `guidance`; `ship`, what to do with finished work; `pr` once one is open; `follows` for a follow-up task; `worker`; `branch`; `base` and `end`, the commits that bound this task's changes on the worker's branch; and `status`
- Goal, Scope and Verify: what to do, which files the worker may edit, and how to check the result
- Todo: a checkbox list the worker checks off as it goes
- Questions: decisions the worker needs from you
- Handoff: what the worker wrote when it finished

Decisions go into the note, not chat. That keeps a task's history in one file you can read, edit and diff, and it keeps chat between seats short.

**Skills.** The protocol each seat follows lives in two [skills](https://code.claude.com/docs/en/skills), `fleet:orchestrator` and `fleet:worker`, in a plugin under `plugin/` that every seat loads with `--plugin-dir`. Each launch prompt in `prompts/` only names the seat, the fleet and its notes folder, and points at the skill. Every fleet message ends its first line with `(handle per /fleet:worker skill)` or the orchestrator equivalent. A seat reads the skill when it uses it, so an edit to a skill reaches running seats from their next message, without a restart. Loading the plugin with `--plugin-dir` works under any config folder.

**Guidance.** A markdown file of working rules that a task note links in its `guidance:` field. `guidance/default.md` in this folder is the starting set. A fleet's own `<notes>/guidance/default.md`, when present, replaces it for that fleet's new tasks. Workers re-read the note before each todo item, so an edit to the note or its guidance applies from the worker's next item. Write a new guidance file to try a different process on one task without changing the prompts.

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
4. Creates the tmux session and its two windows. In each seat pane it types a `claude` command with `--name`, `--settings`, `--append-system-prompt-file`, `--add-dir <notes folder>` and `--plugin-dir <fleet>/plugin`. Workers also get `--permission-mode`, and in a git repo `-w <seat name>` the first time. See "Worker worktrees" below. See the [CLI reference](https://code.claude.com/docs/en/cli-reference).
5. Opens `nvim .` in the notes folder, in a pane left of the orchestrator. That pane is not a seat, so seat commands and `fleet status` skip it.
6. Turns off `allow-set-title` on each pane, so terminal-title updates from Claude Code or nvim do not replace the pane name.

Claude runs inside the pane's shell. When Claude exits, the pane stays open at a prompt.

### Worker worktrees

The first time a worker seat launches in a git repo, its launch line ends in `-w <fleet>-w<n>`, and Claude Code creates the worktree under `<repo>/.claude/worktrees/`. If the repo has a [`WorktreeCreate` hook](https://code.claude.com/docs/en/hooks), Claude Code runs that hook in place of its own setup, so the hook also picks the branch name and base commit. `fleet assign` reads the real branch from the worktree.

Once a seat's worktree exists, `fleet new` and `fleet restart` start the worker inside it, with `cd <worktree> && claude ...` and no `-w`. That covers a fleet started again under the name of one whose worktrees were never cleaned, and every restart. Asking for the same worktree again fails under a hook that refuses an existing name, as some repos' hooks do. It reports `WorktreeCreate hook failed: ... already exists`.

### The task loop

1. You agree on work with the orchestrator.
2. The orchestrator runs `fleet task T3 <title>` and fills in the note.
3. The orchestrator runs `fleet assign w2 T3`. `fleet` brings the worker's branch up to date with the default branch (see "Starting from the default branch" below), fills in the note's Worker and Branch lines, records the branch's commit as Base, commits the notes repo, records `T3` in the seat's `@agent_task` option, and sends `Task T3: read <path>` to the seat.
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

### Starting from the default branch

`fleet assign` updates the worker's worktree before it records Base, so each task starts from the current default branch and its diff holds only its own work:

1. It fetches `origin`, when the repo has one. A failed fetch prints a warning and the update uses the refs already on disk.
2. It finds the default branch: `origin`'s HEAD, else `main` or `master`.
3. A branch with no commits of its own fast-forwards to it. A branch that still carries earlier tasks gets it merged in.
4. A merge conflict aborts the merge and refuses the assignment, with the note unchanged. Resolve it in `fleet shell <seat>`, or assign with `--no-sync`.

A worktree with uncommitted changes is left as is, with a warning. `fleet assign --no-sync` skips the update. Workers don't pull the default branch in themselves during a task, so Base stays accurate.

### Shipping

The note's `ship:` field tells the worker what to do with finished work, after the Verify steps pass and Handoff is written:

| Ship | The worker |
| --- | --- |
| `no`, the default | doesn't push |
| `push` | pushes its branch to `origin` |
| `pr` | pushes and opens a pull request, with `gh pr create` or, for a GitLab remote, `glab mr create` |
| `draft` | does the same as `pr`, opened as a draft |

The worker follows the repo's own conventions for branch names and PR descriptions, from its CLAUDE.md and skills. With none, it pushes to a branch named after the task id. It records the PR's URL in the note's frontmatter as `pr:` and includes it in its `done` report. It never force-pushes.

The orchestrator sets `ship:` from your direction when it writes the task, and sets anything other than `no` only when you've asked for it. To ship a task that finished unshipped, change the field and run `fleet bump <id>`. A PR from a worker's branch includes every earlier task on it that the default branch doesn't have yet, and the worker lists those in the PR body.

### Follow-up work

Where follow-up goes depends on whether the worker has been cleared from the task.

**Before `fleet clear`:** the worker still has the task and its context. Add unchecked items to the note's Todo list, then wake the worker:

- `fleet bump T3` sends `Task T3 was updated: re-read <path>` to the worker. It refuses unless the worker is still on T3. A stopped worker starts a turn when the message arrives, and a busy one reads it between tool calls, so the seat's state doesn't matter.
- `:FleetBump` in nvim saves the note and bumps its worker. `<Leader>b` runs it. With a task id, `:FleetBump T3` works from any buffer inside a fleet.

The worker works the new items, updates Handoff and reports `done` again. Saving a note does not bump the worker, because a save often comes mid-edit. Bump once the follow-up is written.

**After `fleet clear`:** the task is closed. Its End is recorded and its worker's context is gone. Put follow-up in a new task that starts from the closed one:

- `fleet task T3-2 --from T3` creates T3-2 with `follows: T3` in its frontmatter, T3's Scope and Verify sections, and a Goal that links T3's note and says to read its Handoff first. A title after the id replaces the default `follow-up to T3`.
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

### The notes folder

Each fleet's notes folder, `$FLEET_HOME/<fleet>/`, holds the fleet's own record beside its task notes. `fleet new` creates the files below from `templates/` when they're missing and leaves existing ones alone. On a fleet that's already running, `fleet new <name>` adds any that are missing and then switches to it, which is how a fleet started before these files existed gets them.

| Path | Holds | Written by |
| --- | --- | --- |
| `brief.md` | the fleet's goal, constraints, what done means, a Status section on where things stand, and a closing summary | the orchestrator, with you |
| `backlog.md` | planned work not yet turned into tasks, each item linking its task once created | the orchestrator |
| `decisions.md` | dated decisions that apply beyond one task | the orchestrator |
| `knowledge/` | durable findings about the code and environment, one topic per page, listed in `knowledge/index.md` | the orchestrator, from task Handoffs |
| `guidance/` | this fleet's working rules | you or the orchestrator |
| `tasks/` | one note per task | the orchestrator and the task's worker |
| `tasks/archive/` | closed notes moved out by `fleet archive` | fleet |

Seats read these through links, not all at once. A task note links, under its Goal, only the knowledge pages and decisions that task needs. The worker skill tells workers to read what their note links and leave the fleet-level files to the orchestrator. That keeps each worker's context to its task and what it depends on.

### Fleet workflows

- **Kickoff.** On a new fleet, the orchestrator fills in `brief.md` with you before planning, then writes the first items into `backlog.md`.
- **Planning.** Backlog items become tasks through `fleet task`. The orchestrator checks the item off and links the note.
- **Moving findings up.** A worker's Handoff ends with a `### Worth keeping` list. When the task is done, the orchestrator moves those findings into a `knowledge/` page and moves decisions into `decisions.md`, before `fleet clear`. The next worker reads the page instead of rediscovering it.
- **Resetting the orchestrator.** The orchestrator's context grows across the whole fleet. Between phases, it updates the Status section of `brief.md` and asks you to run `fleet clear orch`. It can't clear itself, because `fleet clear` needs an idle seat. Its launch prompt tells it to read `brief.md` and `backlog.md` and run `fleet status` at the start of every session, including after a clear.
- **Archiving.** `fleet archive` moves task notes into `tasks/archive/` when all of these hold: the note is closed (it has an End), it's shipped or not meant to ship (a `pr:` value, or `ship: no`), no worker is still on it, and no note left in `tasks/` links to it or follows it. It updates the fleet files' links to the moved notes and the moved notes' own relative links, then commits, and git records each move as a rename. `--dry-run` lists what it would move. Lookups by task id, such as `fleet diff`, `fleet task --from` and the check for an existing id, find archived notes too. `fleet assign` refuses an archived task, and the save hook and `:FleetBump` ignore archived notes.
- **Closing.** When the goal is met, the orchestrator writes the closing summary in `brief.md` and tells you. You stop the fleet with `fleet kill` and remove its worktrees with `fleet clean`. The notes folder stays as the record.

### Frontmatter

A note's fields live in YAML frontmatter at the top:

```markdown
---
fleet: shop
task: pay-1022-retry-queue
guidance: /Users/kbuchanan/dotfiles/fleet/guidance/default.md
ship: pr
worker: shop-w6
branch: worktree-shop-w6
base: 6e3cad74...
end:
status: blocked
---

# pay-1022-retry-queue: retry queue
```

`fleet:` and `task:` mark the file as a fleet note. nvim's commands, the save hook and the tree column read them, so nothing depends on where the note is kept, including `tasks/archive/`. Each value is one plain line, which `fleet` reads and writes with sed and awk, not a YAML parser. The paths, shas, branch names and URLs stored here need no quoting.

Notes from before frontmatter kept `Key: value` lines under their title. `fleet` still reads those. The first time `fleet` writes to one, it converts the note, and `fleet migrate` converts every old note in a fleet at once and commits. `--dry-run` lists them first. The prose page shows frontmatter as a `yaml` code block.

### Note state in nvim

Two views show task notes' state, both through public APIs, from the frontmatter.

**In nvim-tree,** from `fleet/nvim/lua/fleet/tree.lua`:

- **Sign:** each fleet note gets a status icon in the sign column, left of its name, so the name keeps its full width in a narrow tree. The icons are an empty circle for `assigned`, a spinner for `progress`, a question mark for `blocked`, a cross for `error` and a check for `done`, each in its own colour. nvim-tree's git icon stays beside the name.
- **Name tint:** a blocked or errored note's name is highlighted.
- **Details:** with the cursor on a note, the command line shows its id, worker, status, todos with any open questions, and PR link, cut to the window's width.
- **Mechanics:** the icon and tint come from an nvim-tree decorator, registered in `vimrc` after Git, and the details from `api.tree.get_node_under_cursor()`. nvim-tree redraws when a file in the folder changes, and every status change is a write to the note, so the icon stays current.
- **Sign names:** nvim-tree names each sign after its icon's highlight group, so fleet defines its own groups, `FleetTreeDone` and so on, linked to the diagnostic colours. A sign named `DiagnosticWarn` collides with nvim's own.
- **Glyphs:** they're written as Lua `\u{...}` escapes, because private-use characters don't survive every editor and tool.

**`:FleetBoard [fleet]`,** from `fleet/nvim/lua/fleet/board.lua`, opens a buffer listing one fleet's tasks, with the tasks that need attention first:

```
fleet shop  3 tasks
<CR> open  d diff  b bump  f follow-up  a archived  r refresh  q close

? blocked   T2                    w2           1/3 ?1      search index
~ progress  T3                    w3 waiting   0/1         cart proto
* done      pay-1022-retry-queue  w1           2/2     PR  retry queue
```

- **Columns:** status with its icon (drawn as `?`, `~` and `*` here), task id, worker with the seat's live state from tmux, todos with open questions, a PR mark, and the note's title.
- **Order:** error, blocked, progress and assigned come before done.
- **Keys:** `<CR>` opens the note in the window the board came from, `d` opens the task's diff, `b` bumps its worker, `f` opens the note and runs `:FleetFollowUp`, `a` toggles archived tasks, `r` refreshes and `q` closes.
- **Which fleet:** with no name, the board uses the fleet of the note in the current buffer, or of the current tmux session. Names complete from `fleet ls`.
- **Refreshing:** it redraws when a note of that fleet is saved, and every five seconds while it's visible, because seat states live in tmux and change without a file write.

`fleet/nvim/lua/fleet/note.lua` is the frontmatter reader that the tree, the board and `plugin/fleet.lua` share. It caches each file by size and modification time and counts todos the same way `hooks/task-progress` does. `fleet/nvim/lua/fleet/actions.lua` holds the diff and bump actions the commands and the board share.

### Reviewing progress

The notes folder is a git repo, and `fleet assign` commits it before each task starts. `git -C ~/agents/<fleet> diff` shows everything agents have written in the notes since the last assignment.

Worker code lives on each worker's branch. A worker keeps its branch across tasks, so the branch holds every task that worker has done. The note's Base and End fields mark one task's part of it: `fleet assign` records Base, and `fleet clear` records End.

- `fleet diff T3` shows task T3's changes. While T3 is still its seat's current task, the diff runs in the worktree from Base, so it includes edits the worker hasn't committed. Untracked new files don't show until the worker commits them. After `fleet clear`, it is `Base..End`, so later tasks on the same branch stay out of it. Other arguments go to `git diff`, such as `fleet diff T3 --stat`.
- `fleet diff w2` shows worker w2's whole branch: everything since it left the default branch, through its working tree, so uncommitted edits show too. The default branch is `origin`'s HEAD when the repo has one, else `main` or `master`. Run in a worker's own pane, `fleet diff` with no argument shows that worker's branch. A task note named like a seat wins, so a task can be called `w2`.
- `:FleetDiff` in nvim opens either diff in [diffview.nvim](https://github.com/sindrets/diffview.nvim), one tab with a file list. `:FleetDiff T3` shows the task, and `:FleetDiff w2` the branch. With no argument, and with `<Leader>d`, it shows the branch of the worker the current buffer belongs to: a file in that worker's worktree, or a task note whose `worker:` field names it. Task ids and seats complete.
- Worktrees share the repo's git database, so `git log` and `git diff` see every worker branch from any checkout.

A task assigned before fleet recorded Base has none, and `fleet diff` says so. A seat restarted with `fleet restart` drops its task without recording End. `fleet diff` then shows the task through the branch's latest commit and prints a warning.

### Reports

A worker reports on its task with `fleet report <id> <phase> "<one line>"`, where the phase is `progress`, `done`, `blocked` or `error`. fleet:

1. refuses unless the calling pane is the task's worker, and refuses `done` while the note has unchecked todos
2. writes the phase to the note's `status:` field and appends a dated line to a `## Log` section at the end of the note
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
| `fleet ls` | list running fleets, stopped fleets `fleet clean` hasn't removed, and notes folders with no fleet left (state `notes`), with each one's repo, notes folder and worktree count |
| `fleet archive [--dry-run]` | move closed task notes nothing open needs into `tasks/archive/` |
| `fleet migrate [--dry-run]` | convert a fleet's old-format notes to frontmatter and commit |
| `fleet kill [name]` | kill the tmux session, by default the fleet that owns the calling pane. Worktrees and notes stay on disk. |
| `fleet clean <name> [--branches]` | remove a stopped fleet's worktrees and state. `--branches` also deletes merged worker branches. |
| `fleet status` | each seat's state, task and todo progress |
| `fleet task <id> [--from <id>] <title>` | create a task note and print its path. `--from` starts a follow-up to a closed task. |
| `fleet assign [--no-sync] <seat> <id>` | bring an idle worker's branch up to date with the default branch, then point it at a task note |
| `fleet clear <seat>` | type `/clear` into an idle seat and drop its task |
| `fleet interrupt <seat>` | send Escape |
| `fleet restart <seat>` | kill the seat's process and relaunch its `claude` command |
| `fleet rename <seat> <title>` | change the pane title |
| `fleet path <seat>` | print a worker's worktree path |
| `fleet answer <id>` | tell a worker waiting on a question that the task's questions are answered |
| `fleet report <id> <phase> <text>` | a worker's report on its task: `progress`, `done`, `blocked` or `error` |
| `fleet bump <id>` | tell the worker still on the task that its note has new work |
| `fleet diff [--rev] [<id> \| <seat>] [git diff args]` | show one task's changes, or a worker's whole branch. With neither, in a worker's pane, its branch. `--rev` prints the folder and revision `:FleetDiff` uses. |
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
- **Orchestrator allow rules:** its settings allow `fleet status`, `task`, `assign`, `clear`, `interrupt`, `rename`, `path`, `diff`, `answer`, `bump` and `archive`. Workers' settings allow `fleet report`. `fleet new`, `kill`, `restart`, `clean` and `shell` still prompt you, so the orchestrator can't open windows on its own. See [permissions](https://code.claude.com/docs/en/permissions).
- **Workers:** each worker runs in auto mode, so Claude Code's classifier approves routine actions and you review work through notes and branches.
- **Notes:** every seat may edit files under the fleet's notes folder through an `Edit` allow rule.

## Files

```
bin/fleet                 the command
prompts/orchestrator.md   orchestrator identity, appended to Claude Code's system prompt
prompts/worker.md         worker identity, appended to Claude Code's system prompt
plugin/                   the fleet plugin: skills/orchestrator and skills/worker
templates/task.md         task note template
templates/brief.md, backlog.md, decisions.md, knowledge/index.md
                          fleet-level files fleet new creates in a notes folder
guidance/default.md       default working rules linked from each note
settings.json             crossSessionInbound and hooks, with {{ROOT}} for this folder
hooks/agent-state         sets @agent_state on the calling pane
hooks/register            SessionStart hook: records the session's inbox socket
hooks/todo-check          Stop hook
hooks/task-progress       counts done todos, total todos and open questions
nvim/plugin/fleet.lua     :FleetDiff, :FleetBump, :FleetFollowUp and the save hook, linked into ~/.config/nvim/plugin
nvim/lua/fleet/           note.lua (frontmatter reader), tree.lua (nvim-tree decorator and
                          cursor details), board.lua (:FleetBoard) and actions.lua,
                          linked as ~/.config/nvim/lua/fleet
```

Run state lives outside this folder:

- `~/.local/state/fleet/<fleet>/`: rendered prompts and settings, and the repo root. `XDG_STATE_HOME` moves it. Seats read these files at every launch, including `fleet restart`, so they don't go in `$TMPDIR`, where macOS deletes files nobody has opened for a few days.
- `$FLEET_HOME/<fleet>/`: the notes folder, a git repo. See "The notes folder" above.
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
- Six worktrees created at once. `git` may contend on its locks, and each new worktree may show a workspace trust prompt.

Other behavior to plan around:

- Claude Code records an appended system prompt when a session starts, so editing `prompts/` affects new seats only. Those files hold only each seat's identity. The protocol is in the skills, which running seats re-read.
- A seat whose `SessionStart` hook never ran stays out of `idle`, and `fleet assign` refuses it. `fleet restart` relaunches it.
- Every message between seats counts toward usage like a prompt you type.

## Related Claude Code features

- [Agent teams](https://code.claude.com/docs/en/agent-teams): a lead session spawns teammates that share a task list, with a tmux split-pane display mode. Teammates are spawned by the lead and talk through team mailboxes. `fleet` instead uses a fixed set of named sessions and plain cross-session messaging.
- [Subagents](https://code.claude.com/docs/en/sub-agents): agents that run inside one session. You can't steer them in their own pane the way you can a seat.
- [Background agents](https://code.claude.com/docs/en/agent-view): sessions started with `claude --bg` and listed by `claude agents`.
