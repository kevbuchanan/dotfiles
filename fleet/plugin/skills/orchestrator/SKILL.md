---
name: orchestrator
description: How a fleet orchestrator seat plans, assigns and reviews work, and handles fleet messages. Use when planning or assigning fleet work, and for every message that starts with "From fleet".
---

# Fleet orchestrator

You plan with the user, write task notes, assign them to worker seats and review the results. Do not implement tasks yourself. Merge worker branches into the main checkout only when the user asks.

Task notes live in the fleet's `tasks/` folder, one markdown file per task. The note is the record of the task: decisions, todos, questions, reports and handoff. Keep decisions out of chat. When you and the user settle something, write it into the note.

## Commands

- `fleet status`: each seat's state, task, todo progress and last report.
- `fleet task <id> <title>`: create a note and print its path. Fill in Goal, Scope, Verify and Todo before assigning. Give no two open tasks overlapping Scope.
- `fleet assign <seat> <id>`: send a task to an idle worker.
- `fleet clear <seat>`: clear an idle worker's context and close its task. Run it after each finished task, before the next assignment.
- `fleet bump <id>`: tell the task's worker its note has new items.
- `fleet answer <id>`: tell the task's worker its questions are answered.
- `fleet diff <id>`: one task's changes, including uncommitted edits while it is in progress. Extra arguments go to `git diff`, such as `--stat`.
- `fleet path <seat>`: a worker's worktree path, for reading its files.
- `fleet interrupt <seat>` stops a worker's turn. `fleet rename <seat> <title>` relabels a pane.

## Reports from workers

Workers report through fleet. A report arrives as `From fleet, sent by <worker> (handle per /fleet:orchestrator skill):` followed by `Report: <id> <phase>: <text>`.

- `done`: read the note's Handoff, review the work with `fleet diff <id>`, report the result to the user, then `fleet clear` the seat.
- `blocked`: read the note. Answer from the codebase when you can: write the answer in the note, check it, and run `fleet answer <id>`. Otherwise tell the user which note to answer. Saving the note in nvim wakes the worker.
- `progress`: note it. Act only if it changes the plan.
- `error`: read the note and the worker's pane state, then decide whether to bump it, restart it with the user's approval, or report to the user.

A seat in state `stalled` stopped with unchecked todos. Read its note and decide whether to bump it or report it to the user.

## Follow-up work

- The worker has not been cleared from the task: add unchecked todos to its note, then `fleet bump <id>`.
- The task is closed: run `fleet task <new id> --from <id>`, fill in its Todo list and assign it, preferably to the worker that did the earlier task. `fleet assign` refuses a task that already has an End, and refuses a follow-up whose worker branch lacks the earlier task's work.
