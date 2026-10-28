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

- Follow the guidance file the note's `Guidance:` line links, and read the knowledge pages and decisions the note links. Do not read the rest of the notes folder unless the note asks you to.
- Leave `brief.md`, `backlog.md`, `decisions.md` and `knowledge/` to the orchestrator. Put what you learn in your note.
- Work the Todo list. Check off each item in the note as soon as it is done, and add newly found work as unchecked items.
- Re-read the note before each item. The user and the orchestrator edit notes while you work.
- Work only in this worktree and only on files under Scope. If the task needs other files, report blocked.
- Commit to your branch with messages that start with the task id. Do not merge or rebase other branches, and never force-push.
- `fleet assign` brings your branch up to date with the default branch before the task starts, so the task's diff holds only its own work. Do not pull, merge or rebase the default branch in yourself during a task. If you need newer changes from it, report blocked.

## Handoff

Write `## Handoff` for the next reader: what changed, what you verified and how, and what is left. Under a `### Worth keeping` heading, list findings that would help a later task, such as how a part of the code works, a command that matters, or a trap you hit. The orchestrator moves those into the fleet's knowledge pages.

## Shipping

The note's `Ship:` field says what to do with finished work. The orchestrator sets it, and may change it later and bump you. A note without the field means `no`.

- `no`: do not push.
- `push`: push your branch to `origin`.
- `pr`: push your branch and open a pull request: `gh pr create` for a GitHub remote, `glab mr create` for GitLab.
- `draft`: the same as `pr`, opened as a draft.

Ship after every todo is checked, the Verify steps pass and `## Handoff` is written. Follow the repo's own conventions for branch names, commit messages and PR descriptions, from its CLAUDE.md and skills. With none, push to a branch named after the task id. Take the PR title from the note's heading and the body from its Goal and Handoff, with a line saying fleet task `<id>` produced it. Record the URL in the note's header as `PR: <url>`, and put it in your done report. If the push or the PR fails, report error with the reason.

A PR from your branch includes every earlier task still on it that the default branch doesn't have yet. When that applies, list those tasks in the PR body.

## Questions

When you need a decision, write it under `## Questions` as `- [ ] Qn: <question>` with nested `- [ ] <option>` lines, run `fleet report <id> blocked "<the question, in a line>"`, then stop. Do not ask in chat.

## Reporting

Report with `fleet report <id> <phase> "<one line>"`, never with SendMessage. fleet records the report in the note and sends it to the orchestrator.

- `progress`: a milestone worth telling the orchestrator about, such as a finished part of a long task.
- `done`: every todo is checked, `## Handoff` is written, and the work is shipped as `Ship:` says. fleet refuses `done` while todos are unchecked.
- `blocked`: you wrote a question, or the task needs something outside its Scope.
- `error`: you cannot continue for another reason, such as a broken environment.

A Stop hook sends you back to the Todo list if you stop with unchecked todos and no open question.
