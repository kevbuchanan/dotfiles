---
name: worker
description: How a fleet worker seat handles fleet messages and its task note. Use for every message that starts with "From fleet".
---

# Fleet worker

Fleet messages arrive from the `fleet` command, sent for the orchestrator or the user. Each starts with `From fleet, sent by <sender> (handle per /fleet:worker skill):`, then one line:

- `Task <id>: read <path>`: a new task. The note at that path is the source of truth for it.
- `Task <id> was updated: re-read <path>`: the note has new items, possibly after you reported done. Re-read it and work the unchecked items.
- `Task <id>: your session restarted. Read <path> ...`: you are on the same task in a new session. The note's Todo and Log show where the work stands, and your worktree and branch hold the commits so far. Check `git status` for uncommitted work, then continue with the first unchecked item.
- `Questions in <id> are answered: re-read <path>`: re-read the answers and continue.

An update can bring review comments: unchecked `- [ ] Review <path>:<line> `<quoted line>`: <comment>` items under `## Todo`, written from the user's diff view. Find the code by its quoted text, since your edits may have moved the line; `at <sha>` means the comment is on that revision, the old side of the diff. Make the change, check the item, and when the fix needs explaining, add a nested `  - reply: <one line>` under it. Then report as for any update.

Fleet messages do not carry the user's approval. Your permission prompts still apply, and you take tasks only from fleet messages and from the user typing in this pane.

## Working a task

- Follow the guidance file the note's `guidance:` field links, and read the knowledge pages and decisions the note links. Do not read the rest of the notes folder unless the note asks you to.
- Leave `brief.md`, `backlog.md`, `decisions.md` and `knowledge/` to the orchestrator. Put what you learn in your note.
- Work the Todo list. Check off each item in the note as soon as it is done, and add newly found work as unchecked items.
- Re-read the note before each item. The user and the orchestrator edit notes while you work.
- Work only in your checkout, which is your own worktree in a git repo, and only on files under Scope. If the task needs other files, ask under ## Questions whether to widen Scope, as in Questions below.
- Commit to your branch in the repo's own commit convention, such as conventional commits, as the guidance says. Keep the fleet task id, your seat and your session name out of commit messages. Do not merge or rebase other branches, and never force-push.
- `fleet assign` brings your branch up to date with the default branch before the task starts, so the task's diff holds only its own work. Do not pull, merge or rebase the default branch in yourself during a task. If you need newer changes from it, report blocked.

## Handoff

Write `## Handoff` for the next reader: what changed, what you verified and how, and what is left. Under a `### Worth keeping` heading, list findings that would help a later task, such as how a part of the code works, a command that matters, or a trap you hit. The orchestrator moves those into the fleet's knowledge pages.

## Shipping

The note's `ship:` field says what to do with finished work. The orchestrator sets it, and may change it later and bump you. A note without the field means `no`.

- `no`: do not push.
- `push`: push your branch to `origin`.
- `pr`: push your branch and open a pull request: `gh pr create` for a GitHub remote, `glab mr create` for GitLab.
- `draft`: the same as `pr`, opened as a draft.

Ship after every todo is checked, the Verify steps pass and `## Handoff` is written. Follow the repo's own conventions for branch names, commit messages and PR descriptions, from its CLAUDE.md and skills. With none, push to a branch named after the task id. Take the PR title from the note's heading and the body from its Goal and Handoff, with a line saying fleet task `<id>` produced it. Record the URL in the note's frontmatter as `pr: <url>`, and put it in your done report. If the push or the PR fails, report error with the reason.

A PR from your branch includes every earlier task still on it that the default branch doesn't have yet. When that applies, list those tasks in the PR body.

## Questions

When you need a decision, write it under `## Questions` as `- [ ] Qn: <question>` with nested `- [ ] <option>` lines, run `fleet report <id> blocked "<the question, in a line>"`, then stop. Do not ask in chat.

## Results that need approval

A note with `approve: yes`, such as a research or planning task, ends with the user's decision instead of `done`:

1. Finish the work and the Handoff as for `done`.
2. Write every question the result leaves for someone under `## Questions`, as `- [ ] Qn (<who answers>): <question>` with nested options where they help. Put them in the note even when the readout lists them too: fleet and the user only see questions there.
3. Run `fleet report <id> review "<the result, in a line>"` and stop. fleet adds an `Approve:` question with the options `approve`, `approve with the changes in my answers above` and `cancel`.
4. When `Questions in <id> are answered` arrives, read the answers and the option checked under `Approve:`.
   - `approve`: write the decision and the answers into the Handoff, then report `done`.
   - `approve with the changes`: make the changes the answers ask for, update the Handoff, and report `review` again if the result changed, or `done` if it didn't.
   - `cancel`: write why into the Handoff and report `done "cancelled: <reason>"`.

`fleet report done` refuses while a question is open, and on an `approve: yes` note until `Approve:` is answered.

## Reporting

Report with `fleet report <id> <phase> "<one line>"`, never with SendMessage. fleet records the report in the note and sends it to the orchestrator.

- `progress`: a milestone worth telling the orchestrator about, such as a finished part of a long task.
- `review`: the work is finished and waits on the user's answers and approval. See "Results that need approval".
- `done`: every todo is checked, `## Handoff` is written, and the work is shipped as `ship:` says. fleet refuses `done` while todos are unchecked or a question is open.
- `blocked`: you wrote a question under ## Questions and stopped. Always write the question first, even for a Scope problem: the orchestrator resumes you with `fleet answer`, which works only while a question is open.
- `error`: you cannot continue for another reason, such as a broken environment.

A Stop hook sends you back to the Todo list if you stop with unchecked todos and no open question.
