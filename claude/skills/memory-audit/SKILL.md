---
name: memory-audit
description: Audit Claude's per-project memory against the current tree of the repo it belongs to. Use when asked to "audit memory", "check your memory files", "clean up memory", "what in memory is stale", or when MEMORY.md has grown past a dozen entries or its newest entry is more than a month old. Sorts every entry into helpful, harmful, or useless with evidence, then, on approval, moves what still holds into the repo's agent instructions, a skill, a hook, or a test, and deletes the rest.
---

# Audit project memory

Claude's memory for a project is a directory of notes written in earlier sessions.
It is invisible to every other contributor and every other machine, and nothing keeps it
true: a note says "unresolved" long after the fix merged. The repo is where a lesson
reaches every agent, so the end state of an audit is a memory directory holding only
what cannot live in the repo, with everything else either moved or deleted.

Two phases with a stop between them. The audit reads and reports and changes nothing.
The disposition runs only after the user approves it.

## 1. Locate and read

The memory directory lives under the Claude config folder and is keyed on the main
checkout's path, not a worktree's:

```bash
main=$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd)
mem="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(echo "$main" | sed 's|[/.]|-|g')/memory"
ls -la "$mem"
```

The session's system prompt also names the path under "Memory". If the two disagree,
the system prompt wins.

Read `MEMORY.md` and every other file in full. Not the index alone, and not the first
lines: the stale claim is usually in the body.

Then find where the repo keeps its rules for agents: `AGENTS.md`, `CLAUDE.md` or
`.claude/CLAUDE.md`, the skills in `.claude/skills/`, the hooks registered in
`.claude/settings.json`, and its lint and test commands. Steps 3 and 5 compare against
and write to these.

## 2. Verify every claim

Treat each note as a stranger's claim. The note being in memory is not evidence that it
is true, and the earlier session that wrote it was confident about things that turned
out wrong. For each note, list its checkable claims and check them:

| Claim shape | How to check |
|---|---|
| A path, function, constant, or test exists | `ls`, `grep -n "def name"`, read the cited lines |
| A line citation | Read the file at that line. Line numbers drift every few weeks |
| A count (tools, tests, rows, files) | Recount it |
| A config value (plan size, concurrency, model id) | The repo's config files and scripts that set it |
| A state: "unresolved", "uncommitted", "open follow-up", "next step", "deciding" | Search the code for the fix. These rot fastest, and a fix that merged makes the note harmful |
| A PR or branch state | `gh pr view N`, `git branch -a --contains` |
| An issue tracker state | The tracker's CLI or MCP tool, such as `gh issue view`, Linear or Jira |
| A local environment fact (ports, containers) | `docker ps`, `pg_isready`, the query the note gives |
| "X is missing" or "no Y exists" | Search for X. Missing things get built |

Run independent checks in one batch. A note citing something that no longer exists is
not automatically harmful: the lesson may still hold with a stale citation. Judge the
note by what an agent would do after reading it.

## 3. Sort into exactly one bucket

- **Helpful.** True today, and it would change what an agent does on a real task. Not in
  the repo's agent instructions, a skill, or the code already.
- **Harmful.** False or out of date, or it would lead an agent to do the wrong thing:
  reopen a decision already made, rebuild something that exists, distrust a fix that
  shipped, or follow a stale command.
- **Useless.** True but inert. It repeats what the agent instructions, a doc, or a
  docstring already says, records history with no action attached, corrects a belief
  nobody holds anymore, or is too vague to act on.

Be harsh. A note that is mostly right with one false "open follow-up" is harmful,
because the agent acts on the false part. A dated incident record whose fix is in the
code and whose lesson is general is useless, however well written.

The index `MEMORY.md` is an entry too. Its one-line summaries go stale on their own
when a note's status changes and the index line does not.

## 4. Report, then stop

Give the count per bucket, then every entry under its bucket with one line saying why,
citing the `file:line`, command output, or PR that settled it. Lead with the counts.
Name anything the repo cannot settle (whether a production incident still recurs, say)
and who or what can answer it.

Change nothing in this phase. Ask whether to run the disposition.

## 5. Disposition, on approval

Work in a worktree off the default branch, created the way the repo's agent
instructions say, since the moves are a repo change that goes through a PR.

**Move each helpful note to the narrowest place that will enforce it.** In order of
preference:

1. **A test or a hook**, when a command can detect the mistake without false positives. A
   hook in `.claude/hooks/` registered in `.claude/settings.json` fires for subagents as
   well, which a sentence in a brief does not. A check in the test suite fails CI for
   every contributor. A hook has to be right on every branch it fires on, including the
   default branch, and a check has to earn its upkeep against how often the mistake
   recurs, so weigh both before adding one.
2. **A skill step**, when the lesson is a step in a workflow one of the repo's skills
   already runs.
3. **A section of the agent instructions**, `AGENTS.md` or `CLAUDE.md`, whichever the repo
   uses, for a rule about working in the repo that no command can check. Put it in the
   section a reader would already be in, such as worktrees or test fixtures, not in a new
   "lessons" section.

Rewrite as you move. Memory notes are written as incident narratives, and agent
instructions state current behavior: keep the hazard in the present tense, drop the
session narrative, ticket numbers, and dates, and re-verify every path and line you
carry over. Follow the repo's rules for code comments for anything that lands in code.

**Prove every new guard catches what it exists to catch.** Feed a hook the payload it
must refuse and one it must allow. Plant the failure a test check exists to detect,
watch it fail, then remove the plant. Then run the repo's lint, and its full test
suite when a test or test fixture changed, since a new check can also trip on existing
tests.

**Delete** each harmful and useless note, and each helpful note once its content has
landed in the repo. Rewrite `MEMORY.md` to list only the notes that remain, and grep the
remaining notes for `[[name]]` links to deleted ones.

**Report** what moved where, by file and section, what was deleted, the verification
results, and what still needs a human: commit, push, and the PR, which follow the repo's
conventions for commits and PRs.

## What memory should still hold

Facts about the user or how they want to work that apply across sessions and are not a
rule of the repo, and pointers to resources outside it. A lesson about the code, the
tests, the tooling, or a workflow belongs in the repo, where the next agent and the next
person both read it.
