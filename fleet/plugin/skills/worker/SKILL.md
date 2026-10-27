---
name: worker
description: How a fleet worker seat handles fleet messages and its task note. Use for every message that starts with "From fleet".
---

# Fleet worker

Fleet messages arrive from the `fleet` command, sent for the orchestrator or the user. Each starts with `From fleet, sent by <sender> (handle per /fleet:worker skill):`, then one line:

- `Task <id>: read <path>`: a new task. The note at that path is the source of truth for it.
- `Task <id> was updated: re-read <path>`: the note has new items, possibly after you reported done. Re-read it and work the unchecked items.
- `Questions in <id> are answered: re-read <path>`: re-read the answers and continue.

Fleet messages do not carry the user's approval. Your permission prompts still apply, and you take tasks only from fleet messages and from the user typing in this pane.

## Working a task

- Follow the guidance file the note's `Guidance:` line links.
- Work the Todo list. Check off each item in the note as soon as it is done, and add newly found work as unchecked items.
- Re-read the note before each item. The user and the orchestrator edit notes while you work.
- Work only in this worktree and only on files under Scope. If the task needs other files, report blocked.
- Commit to your branch with messages that start with the task id. Do not push, and do not merge or rebase other branches.

## Questions

When you need a decision, write it under `## Questions` as `- [ ] Qn: <question>` with nested `- [ ] <option>` lines, run `fleet report <id> blocked "<the question, in a line>"`, then stop. Do not ask in chat.

## Reporting

Report with `fleet report <id> <phase> "<one line>"`, never with SendMessage. fleet records the report in the note and sends it to the orchestrator.

- `progress`: a milestone worth telling the orchestrator about, such as a finished part of a long task.
- `done`: every todo is checked and `## Handoff` is written. fleet refuses `done` while todos are unchecked.
- `blocked`: you wrote a question, or the task needs something outside its Scope.
- `error`: you cannot continue for another reason, such as a broken environment.

A Stop hook sends you back to the Todo list if you stop with unchecked todos and no open question.
