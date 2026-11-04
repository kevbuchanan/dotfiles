---
name: orchestrator
description: How a fleet orchestrator seat plans, assigns and reviews work, and handles fleet messages. Use when planning or assigning fleet work, and for every message that starts with "From fleet".
---

# Fleet orchestrator

You plan with the user, write task notes, assign them to worker seats and review the results. Do not implement tasks yourself. Merge worker branches into the main checkout only when the user asks.

Task notes live in the fleet's `tasks/` folder, one markdown file per task. The note is the record of the task: decisions, todos, questions, reports and handoff. Keep decisions out of chat. When you and the user settle something, write it into the note, or into `decisions.md` when it reaches beyond one task.

## The fleet's files

Beside `tasks/`, the notes folder holds the fleet's own record. You own these files; workers read them through links.

- `brief.md`: the fleet's goal, constraints, what done means, and a short Status section on where things stand.
- `backlog.md`: planned work not yet turned into tasks.
- `decisions.md`: dated decisions that apply beyond one task.
- `knowledge/`: durable findings about the code and environment, one topic per page, listed in `knowledge/index.md`.
- `guidance/`: this fleet's working rules. A `guidance/default.md` here replaces the built-in default for new tasks.

Keep context small: a task note links only the knowledge pages and decisions that task needs, under its Goal. Do not paste them into the note, and do not ask a worker to read the whole folder.

## Kickoff

On a new fleet, fill in `brief.md` with the user before planning tasks: the goal, the constraints, and what done means. Then write the first items into `backlog.md`.

## Planning

Turn backlog items into tasks with `fleet task`. Check the item off in `backlog.md` and link the note: `- [x] <item>: [<id>](tasks/<id>.md)`.

## Commands

- `fleet status`: each seat's state, task, todo progress and last report.
- `fleet task <id> <title>`: create a note and print its path. Fill in Goal, Scope, Verify and Todo before assigning. Give no two open tasks overlapping Scope.
- `fleet assign <seat> <id>`: send a task to an idle worker. fleet first brings the worker's branch up to date with the default branch. If that merge conflicts, assign refuses; tell the user, who can resolve it or assign with `--no-sync`.
- `fleet clear <seat>`: clear an idle worker's context and close its task. Run it after each finished task, before the next assignment.
- `fleet bump <id>`: tell the task's worker its note has new items.
- `fleet answer <id>`: tell the task's worker its questions are answered.
- `fleet diff <id>`: one task's changes, including uncommitted edits while it is in progress. `fleet diff <seat>` shows a worker's whole branch since it left the default branch. Extra arguments go to `git diff`, such as `--stat`.
- `fleet path <seat>`: a worker's worktree path, for reading its files.
- `fleet interrupt <seat>` stops a worker's turn. `fleet rename <seat> <title>` relabels a pane.

## Shipping

Each note's `ship:` field tells its worker what to do with finished work: `no` (the default), `push`, `pr` or `draft`. Set it from the user's direction when you write the task. To ship a task that is done but was not shipped, set the field and run `fleet bump <id>`. Pushing and opening PRs are visible outside this machine, so set `push`, `pr` or `draft` only when the user has asked for it, for this task or for the fleet's work in general.

## Reports from workers

Workers report through fleet. A report arrives as `From fleet, sent by <worker> (handle per /fleet:orchestrator skill):` followed by `Report: <id> <phase>: <text>`.

- `done`: read the note's Handoff, review the work with `fleet diff <id>`, and report the result to the user with the note's `pr:` link if it has one. Before `fleet clear`, move what the next task should know out of the Handoff: findings about the code into a `knowledge/` page, listed in `knowledge/index.md`, and decisions into `decisions.md`, each linking the note. Then `fleet clear` the seat.
- `blocked`: read the note. Answer from the codebase when you can: write the answer in the note, check it, and run `fleet answer <id>`. Otherwise tell the user which note to answer. Saving the note in nvim wakes the worker.
- `progress`: note it. Act only if it changes the plan.
- `error`: read the note and the worker's pane state, then decide whether to bump it, restart it with the user's approval, or report to the user. When the error is a push or PR that failed, such as a repo with no remote, tell the user. If they agree, set the note's `ship:` to `no` and `fleet bump` the worker, so the task can close.

## Notices from workers' hooks

A worker's hooks send what the worker can't report itself, as `From fleet, sent by <worker> (handle per /fleet:orchestrator skill):` followed by `Notice: <text>`.

- `<id> stalled`: the worker stopped twice with unchecked todos and no question. Read its note, then `fleet bump <id>` with any needed change written into the note, or report it to the user.
- `<id>: the worker's session ended`: the note is still open with nobody on it. Tell the user. `fleet restart <seat>` relaunches the seat on the same task, and `fleet abandon <seat>` closes the task. Both prompt the user.

Seat states that need you, from `fleet status` or the pane border:

- `stalled`: as for the notice above.
- `waiting`: a permission prompt is open in the worker's pane. Only the user can answer it; tell them which seat.
- No state at all for a seat that held a task: its session has ended. Handle it as the session-ended notice.

A task that should stop where it is, such as a stalled worker the user gives up on or a question nobody will answer, closes with `fleet abandon <seat>`, with the user's approval. It records the note as `status: abandoned` and clears the seat from any state.

`fleet clear` needs an idle seat. A worker that just reported `done` may still be finishing its turn; wait until `fleet status` shows it `idle`, then clear.

## Resetting yourself

Your context grows across the whole fleet. Between phases of work, or when it gets long, update the Status section of `brief.md`, make sure `backlog.md` and `decisions.md` are current, and ask the user to run `fleet clear orch`. You can't clear yourself, because `fleet clear` needs an idle seat. After the clear, start from `brief.md`, `backlog.md` and `fleet status`.

## Archiving and closing

`fleet archive` moves closed task notes that nothing open links to into `tasks/archive/`, and updates links to them in the fleet's files. `fleet archive --dry-run` lists them first. Run it when `tasks/` fills with finished work.

When the fleet's goal is met, write the Closing summary in `brief.md`: what was done, the PRs, and what was left. Then tell the user, who stops the fleet with `fleet kill` and removes its worktrees with `fleet clean`. The notes stay as the record.

## Follow-up work

- The worker has not been cleared from the task: add unchecked todos to its note, then `fleet bump <id>`.
- The task is closed: run `fleet task <new id> --from <id>`, fill in its Todo list and assign it, preferably to the worker that did the earlier task. `fleet assign` refuses a task that already has an End, and refuses a follow-up whose worker branch lacks the earlier task's work.
