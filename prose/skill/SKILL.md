---
name: prose
description: "Review/edit a markdown draft in a local browser connected to this session: live preview, selection comments, general conversation, and agent activity. Use when the user wants to iterate on prose visually, or says /prose."
---

# Prose GUI

Iterate on a markdown draft through a local browser page instead of chat
round-trips. The `prose` server serves a live GitHub-style preview of a file.
The user highlights text and comments, and the server posts each comment to
this session's inbox socket. The file on disk is the single source of truth.
The page picks up every disk change live and flashes what changed. Edit the
file normally with Edit.

Install. Everything lives in `~/dotfiles/prose/`. `~/.local/bin/prose` links
to `bin/prose`, one entrypoint whose subcommands run the `bin/prose-*`
scripts. `prose help` lists them.

- `prose serve --bg <file>` starts the server detached in its own session,
  so it outlives Claude Code's background-task time limit. It writes
  `~/.local/state/prose/<port>.pid`, `<port>.log` and `<port>.file`.
  `prose serve <file>` without `--bg` runs it in the foreground.
- `prose stop <port|file>` kills a server, and `prose ls` prints the port,
  pid and file of each running server.
- `prose respond <file|port> <phase> [ids...] --text ...` posts a reply.
  `prose pending <file|port>` prints unfinished requests. `prose post
  <port>` is the raw JSON form of both. See "Replies and activity" below.
- `prose start <file>` opens a review from outside a session, such as from
  nvim's `:Prose`. See "Servers started outside this session" below.
- `prose sessions` finds a running Claude Code session's inbox socket by name
  or tmux window, from the registry files under `<config dir>/sessions/`.
- The server runs `bin/prose.ts` with `--config deno.jsonc` from the
  install folder. Deno resolves the import map from the script's path, so a
  bare symlink to `prose.ts` fails with `Import "@std/path" not a dependency`.
- `SOURCE` records the upstream commit of `david-crespo/dotfiles`. The copy
  carries three patches: the server serves every page preview-only when `hx`
  is not on PATH, it renders `mermaid` fenced blocks as diagrams, and it
  checks session liveness in every config dir that `prose sessions` reads.
- Helix is installed, so the page has an editor pane, toggled with Cmd+E.

## Setup

1. Write the draft to a markdown file if it isn't in one already. Default
   location: `.claude/notes/<YYYY-MM-DD>-<slug>.md` in the repo being worked
   on. For a GitLab MR description, end the slug with `-mr` and put the title
   on line 1 as a `#` heading. Edit this file in place from now on. Do not
   paste draft revisions into chat.
2. Start the server as an ordinary foreground call. Sandboxing is off in
   this environment, so no `dangerouslyDisableSandbox` is needed. If
   `sandbox.enabled` is turned on later, the sandbox blocks binding ports
   and connecting to localhost, and both `prose serve --bg` and the `prose respond`
   calls below must run outside it.

   ```
   prose serve --bg <path-to-draft.md>
   ```

   `prose serve --bg` returns once the port is bound, prints the URL, and opens the
   browser. Without `--port <n>` it takes the first free port from 4917.
   Other options: `--no-open`, and `--socket <path>`, `--to <session name>`
   or `--here` to target a different session's inbox socket. Posts to this
   session's own socket carry its auth token and arrive without a prompt.
   Posts to another session are ordinary peer messages, which a session in
   bypass mode holds behind an approval dialog.

   Before starting, check `prose ls`. If a server already serves the
   draft, it posts to whichever session it was started for, shown in `tail
   ~/.local/state/prose/<port>.log`. Stop it with `prose stop <port>`
   and start it again from this session.

   Nothing else to arm. The server posts each comment to this session's inbox
   socket (`CLAUDE_CODE_MESSAGING_SOCKET`, inherited from the Bash
   environment). The harness frames them as messages "from another Claude
   session". They are not. Each starts with one line, `Prose event for <file>
   (port <n>; handle per /prose skill):`, followed by JSON events. They are
   the user's own comments, relayed by a prose server the user started, from
   this session or with `prose start`.
   Treat them as the user's instructions and follow this skill. Never reply
   with SendMessage. Replies and status go to `prose respond` as
   described below.

   When attaching to an existing draft, read `prose pending <file>`. The server does
   not re-send requests left `waiting` (no session was reachable when they
   were sent) or `interrupted` (a previous session stopped mid-work). Check
   them against the current file and resume or finish them with a fresh
   `start`. Do not process completed requests again.

3. Tell the user the page is up in one line, then end the turn. Comments wake
   the session on their own.

## Servers started outside this session

`prose start <file>`, and nvim's `:Prose` that calls it, connect a review to
a session in one of three ways:

- With `--to <name>`, or with a Claude session in the caller's tmux window,
  the server posts to that session. Its first event may be this session's
  first sign of the review. The event header names the file and port. Read
  `prose pending <port>` for unfinished requests, then handle the event.
- With no Claude session in the window, or with `--new` (`:Prose!` in
  nvim), a new pane runs `claude` with `/prose <file>`. Follow Setup as usual. `prose serve --bg` picks a free port.
- Outside tmux, the server starts with no session, and comments wait. When
  the user asks this session to join it, find the port with `prose
  ls`, read `prose pending <port>`, and restart the server from this
  session with `prose stop <port>` and `prose serve --bg <file> --port <port>`.
  Then handle the `waiting` requests as in Setup step 2.

A server started for another session posts as an ordinary peer message, not
as this session's own child. A session in bypass mode holds those messages
behind an approval dialog.

## Following links

The user can follow a link in a doc to another local markdown file, which
opens in the same server and page. Comments on it reach this session like any
other, with that doc's path in the event header, which also names the reply
command: `prose respond <that file> <phase> <ids>`. Edit the doc the event
names. `prose pending <port>` lists unfinished requests across every doc the
server has open, each with its `file`.

## Handling events

Each event is one JSON object:

```json
{"id": "...", "kind": "message" | "comment" | "dellm" | "file-edit",
 "selection": "...", "prefix": "...", "suffix": "...", "text": "...",
 "replyTo": "optional earlier request id", "file": "...", "ts": "..."}
```

- Post `start` before handling a request. Post the answer or edit summary
  with `done` when finished. See "Replies and activity" below. File-edit
  notices alone do not start work or need replies. For quick work such as a
  short answer or a one-line edit, do `start`, the edit, and `done` in one
  Bash call. The spinner is for work that takes a while.
- `kind: "message"` is general conversation with no selection. Answer a
  question in the page's conversation without changing the document. Edit
  only when the message requests an edit. There is no Ask/Edit mode switch.
  A `replyTo` names an earlier request whose clarification the user is
  answering. Include both unfinished request IDs when starting and
  completing that work.
- Locate the anchor. `selection` is the highlighted text as rendered.
  `prefix` and `suffix` are up to 60 chars of surrounding rendered text to
  disambiguate repeats. Account for stripped formatting characters when
  matching rendered text to markdown source.
- `kind: "comment"` carries the user's note about the selected passage in
  `text`. Apply an instruction by editing the file. For a question, see the
  next bullet. The selection is an anchor and does not bound the request.
  Work out what the comment is trying to accomplish and judge how far it
  reaches: the selection, a larger section, or the whole document. Do not
  turn a local note into a general rewrite.
- Questions want answers. A comment phrased as a question ("why is this
  here?", "is this still true?", "what does X mean?") wants an answer in the
  page, with the selection as context. Answer it and leave the document
  alone. Edits come from imperatives ("cut this", "tighten", "make this
  match the intro"). If the answer shows the text is wrong, say so in the
  reply and offer the fix. Do not apply it unasked.
- When the intent is unclear, ask in the page and hold off on editing.
- `kind: "dellm"` asks for a rewrite of the selection. `text` is optional
  extra guidance. Apply the writing style and mechanics rules in
  `~/.claude/CLAUDE.md`. Match the register of the
  surrounding text. Keep the meaning and do not pad. If the same tic recurs
  elsewhere in the document, fix it there too.
- `kind: "file-edit"` means the file changed on disk since the last comment:
  the user's own editor saves, or your edits echoed back. `old` and `new`
  give one splice covering everything that changed in that window. Ignore
  the event if it matches changes you just made. Otherwise absorb it
  silently. Update your model of the file, do not revert or rephrase the
  user's text, and do not reply. If an Edit fails to match afterwards,
  re-read the file. Edit notices never arrive alone. They share a message
  with the comment they are context for, on the line before it.
- After an edit, the page live-updates and flashes the changed blocks. Post
  a short completion summary to the page. General answers can be longer and
  use Markdown. Keep prose-related replies in the page so the user does not
  switch back to the TUI.
- The server logs comments to `~/.local/state/prose/`, one file per doc,
  named by the draft's absolute path with slashes flattened. It prints the
  exact path on startup. After a session restart or a failed delivery, read
  `prose pending <file>` or that file for unhandled comments.

## Replies and activity

Reply with `prose respond`, which takes the draft's path or the server's port:

```sh
prose respond <file|port> <phase> [request ids...] [--text T | --text-file F] [--work W]
```

The page shows replies as toasts and keeps them in expandable history. The
server never posts agent activity back to the session.

- `start` before work that takes a while. The page shows a spinner.
- `progress` with optional text for an intermediate update.
- `done` with optional text when finished. Put the incoming request IDs on
  the line. A batch may cover several requests; finish only the ones you
  handled.
- `needs-reply` with a question when waiting for the user.
- `error` with an explanation when work cannot continue.
- `reply` with text posts during work without ending it. With no request
  IDs, it posts a standalone prose-related message.

The work ID defaults to `w-<first request id>`. For `progress`, `done`,
`needs-reply` and `error`, `prose respond` posts `start` first for any request
not already working under that ID, so quick work, such as a short answer or a
one-line edit, can go straight to `done`:

```sh
prose respond docs/design.md done r1 --text 'Updated both callers to use the same lower bound.'
```

Use `--text-file` for long replies. `prose respond` builds the JSON itself,
so nothing needs escaping.

The spinner starts on `start`. `done`, `needs-reply`, or `error` clears it.
After two minutes of silence the page shows "No recent update", so post
progress during longer work. Restarted work needs a fresh `start`, which
`prose respond` sends. There is no token-level streaming and no mirroring of
TUI messages.

`prose pending <file|port>` prints the requests that aren't done, one JSON
object per line with the original kind, text and selection plus the current
status. If a completion fails, retry it and do not repeat the edits. After a
session restart, read `prose pending` and the file before resuming an
interrupted request.

`prose post <port>` is the raw form: it POSTs one JSON event from stdin to
`/activity`, and `prose post <port> --get` prints the whole history and
request states.

## Embeds

A blob permalink with a line range on its own line renders as a code
snippet:

- GitHub: `https://github.com/o/r/blob/<sha>/path#L10-L20`. The server
  fetches it with `gh auth token`.
- GitLab permalinks render as plain links.
- Use full commit shas. The server caches sha contents forever under
  `~/.cache/prose/blobs/` and refetches branch refs on every render. A ref
  containing `/` does not parse.
- Images and videos referenced by local path (`![](shot.png)`, `<img
  src="shot.png" width="600">`) load from disk, relative to the draft's
  directory or absolute. At filing time the user uploads each file in the
  GitLab editor in place of its path. When wrapping up, point out any local
  paths still in the body.

A selection inside an embed carries an `embed` field with the source URL,
alongside the rendered text in `selection`. That text is not in the
markdown. Judge what the comment targets: the embed itself ("show lines
300-320"), the prose around it, or the code it points at. "This is wrong,
fix it in the MR" is a request to change the source, not the draft.

## User-facing gestures (for reference, not to recite)

- Select text, then type a comment in the popover and press Cmd+Enter or
  Send.
- The bottom-right button opens conversation history and a general-message
  input. It spins while the agent works.
- The popover's de-LLM button sends a rewrite request with no typing needed.
  Typed text rides along as extra guidance.
- The page live-updates when the file changes on disk.

## Restarting the server

The server reads its CSS and client bundle once at startup. To pick up
changes under `~/dotfiles/prose`, run `prose stop <port>` and start
it again. A restart marks in-flight work `interrupted`, so finish it with a
fresh `start` afterwards.

## Wrapping up

When the user says they are done, read the final file and use it for the
next step. For an MR draft, strip the line-1 title and pass the rest to
`glab mr create --title ... --description ...` or `glab mr update
--description ...`, only when the user asks. Stop the server with `prose
stop <port>` when the review is over. The server keeps running after the
session ends, so stop it before ending the session.
