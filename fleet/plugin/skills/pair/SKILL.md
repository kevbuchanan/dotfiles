---
name: pair
description: How a session opened with `fleet pair` works with a fleet's notes - where planned work, findings and decisions go, and what to record in the task's note. Use in a session whose start prompt says it is pairing on a fleet task, when work comes up that belongs to the fleet beyond this conversation, and when asked to add something to the fleet's backlog, knowledge or decisions.
---

# Pairing on a fleet task

You work with the user on one task of a fleet, in a checkout at the state its note records. The orchestrator and the workers run in other panes. You are none of them: you take direction from the user, and what you learn reaches the fleet through its notes.

## The notes folder

The notes folder is the `--add-dir` folder, the parent of `tasks/`. It is a git repo.

- `tasks/<id>.md`: one note per task. YAML frontmatter, then Goal, Scope, Verify, Todo, Questions, Handoff and Log. Your task's note is the one the start prompt names. `tasks/archive/<YYYY-MM>/` holds closed notes.
- `brief.md`: the fleet's goal, constraints, what done means, and a Status section. The orchestrator owns it. Read it for context.
- `backlog.md`: planned work not yet turned into a task, one `- [ ] <item>` line each. The orchestrator turns an item into a task and checks it off with a link to the note.
- `decisions.md`: dated decisions that reach beyond one task.
- `knowledge/`: durable findings about the code and the environment, one topic per page, each listed in `knowledge/index.md`.

## Sending work back to the fleet

- **Work for later**, such as a follow-up MR, an alert or a dashboard: add a `- [ ] ` item to `backlog.md`. Write it so the orchestrator can turn it into a task without this conversation: what to do, why, and where it starts, with the files, MRs or docs it builds on. End it with the source, such as `(from pay-1022-retry-queue pairing)`.
- **A finding the next task needs**: add or extend a page in `knowledge/` and list it in `knowledge/index.md`.
- **A decision the user made that reaches beyond this task**: add a dated entry to `decisions.md` that links the task's note.
- **What this session did**: append a dated line to the task note's `## Log`, as `- YYYY-MM-DD HH:MM pair: <what changed, the commits, and the backlog items added>`. The frontmatter belongs to fleet's commands, so leave it as it is.
- **More work on this task's code for a worker**: tell the user, who runs `:FleetFollowUp` in nvim or asks the orchestrator. When the user asks you to, `fleet task <new id> --from <id>` creates the follow-up note.

## What stays with fleet

- Commands that drive seats are the orchestrator's and the workers': `fleet report`, `assign`, `clear`, `bump`, `answer`, `abandon` and `restart`. Do not run them, and do not message the orchestrator or the workers.
- Edit only your task's note and the fleet-level files above. Other open notes belong to the workers on them.
- Leave the notes repo uncommitted. fleet commits it under a lock when it assigns or archives, and other sessions' edits may be pending in it. Tell the user which notes files you changed.
- Commit code in the repo's own convention, without the fleet task id or seat names.
