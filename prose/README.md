# prose

`prose` serves a live, GitHub-style preview of one markdown file in the browser. You select text, write a comment, and the server delivers the comment to a Claude Code session. Claude edits the file on disk and posts a reply back to the page. The file on disk is the only copy of the draft. The page re-renders on every disk change and flashes the blocks that changed.

```sh
prose-start docs/design.md        # from a shell
:Prose                            # from nvim, on the current file
/prose docs/design.md             # from inside a Claude Code session
```

## Requirements

- `deno` to run the server
- `nc` and `perl`, which macOS ships with. The server posts to a session's socket through `nc`, and `prose-bg` detaches with `perl`.
- `jq` for `prose-session`
- `hx` (Helix), optional. With it, the page has an editor pane, toggled with Cmd+E. Without it, every page is preview-only.
- `gh`, optional. With it, GitHub blob permalinks render as code snippets.
- tmux, for `prose-start` to find or open a Claude pane
- Claude Code 2.1.224 or later on macOS or Linux, for [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)

## Concepts

**Server.** One `prose` process serves one file on one port, from 4917 up. It keeps running after the session or editor that started it exits. `prose-bg --list` shows every running server, and `prose-bg --stop <port>` stops one.

**Target session.** Each server delivers comments to one Claude Code session's inbox socket, chosen when the server starts. Every session binds a socket and exports its path to its child processes as `CLAUDE_CODE_MESSAGING_SOCKET` ([the session's inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket)). A server started from a session's Bash tool picks up that variable with no flag. A server started from nvim or a shell gets the socket path from `prose-start`.

**Event.** A comment, a general message, or a de-LLM rewrite request. Each event reaches the session as a message starting with `Prose event for <file> (port <n>; handle per /prose skill):`, followed by JSON. The [skill](skill/SKILL.md) tells Claude how to handle each kind.

**Activity.** Claude's replies and status updates. Claude posts them to the server's `/activity` endpoint with `prose-post`. The page shows them as toasts and keeps them in a history panel. Nothing in the page's activity is sent back to the session.

**Skill.** `skill/SKILL.md` is the `/prose` skill. It covers starting a server, handling each event kind, replying, and joining a server started elsewhere.

## Starting a review

`prose-start <file>`, and nvim's `:Prose`, choose the target session in this order:

1. `--to <name>`, or `:Prose <name>`, targets the running session with that name. Names complete in nvim.
2. Inside tmux, the server targets the Claude session in the caller's tmux window.
3. Inside tmux with no Claude session in the window, or with `--new` (`:Prose!`), a new pane opens right of the caller. It runs `claude -n prose-<file name> "/prose <file>"` from the file's git root, and that session starts the server itself through the skill.
4. Outside tmux, the server starts with no session. Comments are logged and wait until a session joins the server through the skill.

`PROSE_CLAUDE` sets the command the new pane runs, `claude` by default. The pane runs an interactive shell, so an alias such as `claude-tm` works.

### How comments reach the session

- **Own server:** a server the session started posts as one of the session's own child processes, with the token from `CLAUDE_CODE_MESSAGING_TOKEN`. Claude Code delivers those messages with no prompt.
- **Server started elsewhere:** a server started by `prose-start` for an existing session posts as an ordinary peer message. Claude Code applies the session's [inbound controls](https://code.claude.com/docs/en/cross-session-messaging#control-inbound-messages) to it. With no `crossSessionInbound` setting, a session in bypass-permissions mode holds each such message for your approval, and other sessions get it straight away.
- **Delivery timing:** an idle session starts a turn when an event arrives. A busy session reads it between tool calls.

### Finding sessions

`prose-session` reads Claude Code's session registry, one `<config dir>/sessions/<pid>.json` file per running session. Each file records the session's name, tmux pane and socket path. Claude Code doesn't document this format, so an update can break the lookup. The server's check that its session is still running reads the same files.

Config dirs searched:

- `~/.claude`
- `$CLAUDE_CONFIG_DIR`
- each folder in the colon-separated `$PROSE_CLAUDE_DIRS`

A session started with `CLAUDE_CONFIG_DIR` set registers under that folder, so add it to `PROSE_CLAUDE_DIRS`. `zshrc` does this for `claude-tm`.

## Commands

| Command | Effect |
| --- | --- |
| `prose-start <file> [--to NAME \| --new] [--no-open] [--port N]` | start a review and pick its session, as above |
| `prose-bg <file> [--port N] [--no-open] [--socket PATH \| --to NAME \| --here]` | start a server detached, with an explicit target |
| `prose-bg --list` | port, pid and file of each running server |
| `prose-bg --stop <port>` | stop a server |
| `prose-post <port> < event.json` | post one activity event |
| `prose-post <port> --get` | print a server's history and request states |
| `prose-session --name NAME \| --window [PANE] \| --list` | print a session's socket path, or list sessions |
| `prose <file> [--port N] [--no-open] [--socket PATH]` | run the server in the foreground |

In nvim:

| Command | Effect |
| --- | --- |
| `:Prose [session]` | `prose-start` on the current file, with `--to` when a session is named |
| `:Prose!` | `prose-start --new` on the current file |
| `:ProseStop` | stop the server for the current file |
| `:ProseList` | list running servers |

`:Prose` saves the buffer first, because the server reads the file from disk. Combined with the vimrc timer that reloads changed files, nvim shows Claude's edits within a second.

## State

| Path | Contents |
| --- | --- |
| `~/.local/state/prose/<port>.pid`, `.log`, `.file` | a running server's pid, its log, and the file it serves |
| `~/.local/state/prose/<flattened path>.comments.jsonl` | every comment on a file, kept across restarts |
| `~/.cache/prose/blobs/` | GitHub blob contents, kept forever for full commit shas |

`XDG_STATE_HOME` moves the state folder, and `XDG_CACHE_HOME` moves the cache.

## Files

```
bin/prose            wrapper: runs bin/prose.ts with deno.jsonc and its permission flags
bin/prose-bg         starts the server detached
bin/prose-start      picks a session, then calls prose-bg or opens a Claude pane
bin/prose-session    reads the session registry
bin/prose-post       posts to and reads /activity
bin/prose.ts         the server
bin/prose-client.ts  the page script, bundled by the server at startup
bin/prose-pty.py     runs hx in a pty for the editor pane
bin/lib/             CSS, and the conflict, event, conversation and session modules
deno.jsonc           import map
deno.lock            locked dependency versions
skill/SKILL.md       the /prose skill
nvim/plugin/prose.lua  :Prose, :ProseStop and :ProseList
LICENSE              MIT license of the upstream code
SOURCE               upstream repo and commit
```

The `prose` wrapper resolves its own folder through the `~/.local/bin` symlink. Deno looks for `deno.jsonc` next to the script it runs, so a bare symlink to `prose.ts` fails with `Import "@std/path" not a dependency`.

The server reads its CSS and bundles the client once at startup. After editing anything under `bin/`, restart a server with `prose-bg --stop <port>` and start it again. A restart marks in-progress requests `interrupted`.

## Upstream

The server comes from `david-crespo/dotfiles` at the commit in `SOURCE`, under its MIT license. This copy has three changes:

- **Preview-only without Helix:** `prose.ts` checks for `hx` at startup. Without it, the server serves every page preview-only and refuses `/pty`.
- **Mermaid:** `prose-client.ts` renders `mermaid` fenced blocks as diagrams.
- **Liveness across config dirs:** `sessionAlive` in `bin/lib/prose/session.ts` checks every config dir listed under "Finding sessions" above. Upstream checks only `~/.claude`.

The wrappers and the `prose-start` and `prose-session` scripts exist only here. To update from upstream, diff the upstream files at a new commit against the ones at `SOURCE`, apply that diff here, and update `SOURCE`.

## Related Claude Code docs

- [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging): inbox sockets, delivery, inbound controls, and limits
- [Skills](https://code.claude.com/docs/en/skills): how `/prose` loads
- [CLI reference](https://code.claude.com/docs/en/cli-reference): `--name`, used for the new pane's session
- [Settings reference](https://code.claude.com/docs/en/settings-reference#crosssessioninbound): `crossSessionInbound`
