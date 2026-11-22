# Personal coding and writing rules

## Code comments

You MUST:

- Describe the current state of the code. Never narrate how it got there.
  No "previously", "changed to", "the fix", "now correctly handles", no
  before/after framing.
- Comment on what is not obvious from the code itself: why a choice was
  made, an invariant that is load-bearing, a constraint imposed by another
  system, a value that is pinned or frozen and why.
- Describe the subject, not the task. A comment in a build file describes
  the build, not the ticket that added it.
- Omit ticket numbers, MR numbers, and phrases like "scaffold only" or
  "phase 1" from code, comments, and READMEs. Tracking belongs in Jira and
  the MR.

You MUST NOT:

- Restate what the next line does.
- Leave TODOs referencing in-flight work in another branch or MR.

@~/.claude/writing.md

## Scope

You MUST:

- Deliver the requested scope only. Do not fold in cleanup, refactors,
  renames, or unrelated files. When porting or reproducing an existing
  change, match its file set.
- Break large work into small reviewable MRs and present the breakdown for
  review before implementing.
- Present a plan for Jira ticket updates or Confluence page changes and wait for approval
  before applying them.
- When picking up work, move Jira or Linear tickets into In Progress, and along to the next step from there.
- Draft locally and show the draft first. Commit, push, publish, and post
  only when explicitly asked, one action at a time.
- Call out claims that need verification by a named person, and say where
  you are overconfident, when asked to assess your own output.
