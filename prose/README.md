# prose

`prose` serves a live, GitHub-style preview of one markdown file in the browser. You select text, write a comment, and the server delivers the comment to a Claude Code session. Claude edits the file on disk and posts a reply back to the page. The file on disk is the only copy of the draft. The page re-renders on every disk change and flashes the blocks that changed.

```sh
prose start docs/design.md        # from a shell
:Prose                            # from nvim, on the current file
/prose docs/design.md             # from inside a Claude Code session
```

## Requirements

- `deno` to run the server
- `nc` and `perl`, which macOS ships with. The server posts to a session's socket through `nc`, and `prose serve --bg` detaches with `perl`.
- `jq` for `prose sessions`, `prose respond` and `prose pending`
- `hx` (Helix), optional. With it, the page has an editor pane, toggled with Cmd+E. Without it, every page is preview-only.
- `gh`, optional. With it, GitHub blob permalinks render as code snippets.
- tmux, for `prose start` to find or open a Claude pane
- Claude Code 2.1.224 or later on macOS or Linux, for [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)

## Concepts

**Server.** One `prose` process on one port, from 4917 up, starts with one file and opens more as you follow links from it. It keeps running after the session or editor that started it exits. `prose ls` shows every running server, and `prose stop <port|file>` stops one.

**Target session.** Each server delivers comments to one Claude Code session's inbox socket, chosen when the server starts. Every session binds a socket and exports its path to its child processes as `CLAUDE_CODE_MESSAGING_SOCKET` ([the session's inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket)). A server started from a session's Bash tool picks up that variable with no flag. A server started from nvim or a shell gets the socket path from `prose start`.

**Event.** A comment, a general message, or a de-LLM rewrite request. Each event reaches the session as a message starting with `Prose event for <file> (port <n>; handle per /prose skill):`, followed by JSON. The [skill](skill/SKILL.md) tells Claude how to handle each kind.

**Activity.** Claude's replies and status updates. Claude posts them to the server's `/activity` endpoint with `prose respond`, which takes the draft's path or the port and sends `start` itself when work hasn't started, so quick work goes straight to `done`. The page shows them as toasts and keeps them in a history panel. Nothing in the page's activity is sent back to the session.

**Theme.** Both pages follow the system's light or dark setting. The button at the top right, beside the editor toggle on the markdown page and beside "Send review" on the diff page, steps through system, light and dark. The choice is a cookie for localhost, so it carries to every prose page on any port. Mermaid diagrams redraw in the matching theme.

**Skill.** `skill/SKILL.md` is the `/prose` skill. It covers starting a server, handling each event kind, replying, and joining a server started elsewhere.

## Starting a review

`prose start <file>`, and nvim's `:Prose`, choose the target session in this order:

1. `--to <name>`, or `:Prose <name>`, targets the running session with that name. Names complete in nvim.
2. Inside tmux, the server targets the Claude session in the caller's tmux window.
3. Inside tmux with no Claude session in the window, or with `--new` (`:Prose!`), a new pane opens right of the caller. It runs `claude -n prose-<file name> "/prose <file>"` from the file's git root, and that session starts the server itself through the skill.
4. Outside tmux, the server starts with no session. Comments are held until a session joins with `prose join`.

`PROSE_CLAUDE` sets the command the new pane runs, `claude` by default. The pane runs an interactive shell, so a shell alias works.

### How comments reach the session

- **Own server:** a server the session started posts as one of the session's own child processes, with the token from `CLAUDE_CODE_MESSAGING_TOKEN`. Claude Code delivers those messages with no prompt.
- **Server started elsewhere:** a server started by `prose start` for an existing session posts as an ordinary peer message. Claude Code applies the session's [inbound controls](https://code.claude.com/docs/en/cross-session-messaging#control-inbound-messages) to it. With no `crossSessionInbound` setting, a session in bypass-permissions mode holds each such message for your approval, and other sessions get it straight away.
- **Delivery timing:** an idle session starts a turn when an event arrives. A busy session reads it between tool calls.

### Finding sessions

`prose sessions` reads Claude Code's session registry, one `<config dir>/sessions/<pid>.json` file per running session. Each file records the session's name, tmux pane and socket path. Claude Code doesn't document this format, so an update can break the lookup. The server's check that its session is still running reads the same files.

Config dirs searched:

- `~/.claude`
- `$CLAUDE_CONFIG_DIR`
- each folder in the colon-separated `$PROSE_CLAUDE_DIRS`

A session started with `CLAUDE_CONFIG_DIR` set registers under that folder, so add it to `PROSE_CLAUDE_DIRS`.

## Diff reviews

`prose diff` opens a unified diff of a git checkout in the browser, with line comments for a Claude Code session. With no git arguments it shows the checkout's changes since it left the default branch, with uncommitted edits and untracked files, so a branch's review covers what is about to be pushed. Any `git diff` arguments replace that, such as `main...HEAD`, `HEAD~3` or `--cached`, and show what `git diff` shows for them, which leaves out untracked files. Untracked files skip those `.gitignore` covers, and past 200 the rest are left out and the page's title counts them.

```sh
prose diff                        # this checkout, since the default branch
prose diff -- main...HEAD         # committed work only
:ProseDiff                        # from nvim, on the current file's checkout
fleet review <task>               # a fleet task's changes; comments go to its note
```

The page renders each file with [@pierre/diffs](https://diffs.com), with Shiki syntax colors and word-level highlights.

- **Commenting:** hover a line and press the `+` in its gutter, or drag the `+` down several lines for a range. The comment form opens under the lines. ⌘⏎ or "Add to review" keeps the comment as a draft, which lives in the browser until "Send review" sends every draft in one delivery. "Send now" sends one comment by itself.
- **Anchors:** each comment records its file, side (`new` or `old`), lines, the first line's text, and the commit that side was read at. The agent finds the code by that text, and so does the page after the diff changes. A line with fewer than three letters or digits, such as `}` or a blank line, matches too many others to follow, so a comment on one goes outdated when its line changes.
- **Threads:** a sent comment shows under its lines with its status and the agent's replies from `prose respond`. "Reply" continues the thread. A comment whose line no longer reads as it did moves to an "Outdated" box above its file.
- **The diff changing:** the page polls every four seconds while visible and shows a "The diff changed" bar with a Refresh button. It never re-renders on its own, so a line doesn't move under a comment being written.
- **The file tree:** a sidebar lists the changed files by folder, from [@pierre/trees](https://diffs.com), with each file's git status, `+`/`−` line counts, comment and draft count, and a ✓ once viewed. Clicking a file scrolls to its diff, and the search box filters the tree. On a window narrower than 900px the tree sits above the diff.
- **Viewed files:** the "Viewed" box in a file's header collapses it. The mark is keyed to that file's part of the diff, so a file the agent changes again shows as unviewed.
- **The per-run token:** the server puts a random token in the page, and `/comment` and `/review` refuse a request without it. With the origin checks under "Requests from the browser", another site open in the browser can't send text to the agent. A local process can read the page, as it can write to the session's socket itself.

`prose diff` picks the session as `prose start` does: `--to <name>`; the calling session, when run from a Claude Code session's Bash tool; the Claude session in the caller's tmux window; or, with none of those or with `--new`, a new pane running `claude` with `/prose diff`. A review already open for the same checkout and arguments opens again in the browser instead of starting twice. Replies take the port: `prose respond <port> done <id> --text '...'`.

A fleet task's review, `prose diff --task <id> [-s <fleet>]` or `fleet review <id>`, reaches no session. Each comment becomes a review todo in the task's note through `fleet comment`, as nvim's `:FleetComment` writes one, and "Send review" runs `fleet bump`. The page reads the note as it changes: a checked todo shows its thread as done, and each indented `- reply:` line under the todo shows as the worker's reply. See [fleet](../fleet/README.md#review-comments).

## Commands

`prose` is one entrypoint. Each subcommand runs a script in `bin/`, and `prose help` lists them.

| Command | Effect |
| --- | --- |
| `prose start <file> [--to NAME \| --new] [--no-open] [--port N]` | start a review and pick its session, as above |
| `prose diff [-C DIR] [--to NAME \| --new] [--no-open] [--port N] [git diff args...]` | start a diff review of a checkout; see "Diff reviews" |
| `prose diff --task ID [-s FLEET] [--no-open] [--port N]` | start a diff review of a fleet task, whose comments go to its note |
| `prose serve <file> --bg [--port N] [--no-open] [--socket PATH \| --to NAME \| --here]` | start a server detached, with an explicit target |
| `prose serve <file> [--port N] [--no-open] [--socket PATH]` | run the server in the foreground |
| `prose ls` | port, pid and file of each running server |
| `prose stop <port\|file>` | stop a server |
| `prose respond <file\|port> <phase> [ids...] [--text T \| --text-file F] [--work W]` | post a reply, sending `start` first when needed |
| `prose pending <file\|port>` | print unfinished requests with their text and status |
| `prose port <file\|port>` | print the port of the server for a file |
| `prose join <file\|port>` | point a server at the calling Claude session and send it the held requests |
| `prose post <port> [--file F] < event.json` | post one raw activity event, to doc `F` when given |
| `prose post <port> [--file F] --get` | print a doc's history and request states, the first file's by default |
| `prose sessions --name NAME \| --window [PANE] \| --list` | print a session's socket path, or list sessions |

In nvim:

| Command | Effect |
| --- | --- |
| `:Prose [session]` | `prose start` on the current file, with `--to` when a session is named |
| `:Prose!` | `prose start --new` on the current file |
| `:ProseStop` | stop the server for the current file |
| `:ProseList` | list running servers |
| `:ProseDiff[!] [git diff args]` | `prose diff` on the current file's checkout; `!` adds `--new`. Refs complete. |

`:Prose` saves the buffer first, because the server reads the file from disk. Combined with the vimrc timer that reloads changed files, nvim shows Claude's edits within a second.

## State

| Path | Contents |
| --- | --- |
| `~/.local/state/prose/<port>.pid`, `.log`, `.file` | a running server's pid, its log, and the file it serves |
| `~/.local/state/prose/<flattened path>.comments.jsonl` | every comment on a file, kept across restarts |
| `~/.local/state/prose/diff-<flattened key>-<hash>.comments.jsonl` | every comment in a diff review, keyed by its checkout and git arguments, or by its fleet task |
| `~/.cache/prose/blobs/` | GitHub blob contents, kept forever for full commit shas |

`XDG_STATE_HOME` moves the state folder, and `XDG_CACHE_HOME` moves the cache.

## Files

```
bin/prose            the entrypoint: dispatches each subcommand to a script below
bin/prose-serve      `serve`: runs bin/prose.ts with deno.jsonc and its permission flags
bin/prose-bg         `serve --bg`, `stop` and `ls`: the detached server and its state files
bin/prose-start      `start`: picks a session, then starts a server or opens a Claude pane
bin/prose-session    `sessions`: reads the session registry
bin/prose-post       `post`: posts to and reads /activity
bin/prose-respond    `respond`: replies to a page by file or port
bin/prose-pending    `pending`: lists unfinished requests
bin/prose-port       `port`: finds the port of a file's server
bin/prose-diff       `diff`: picks a session or a fleet task, then starts a diff server
bin/prose-diff-serve runs bin/prose-diff.ts with deno.jsonc and its permission flags
bin/prose.ts         the server
bin/prose-client.ts  the page script, bundled by the server at startup
bin/prose-diff.ts    the diff review server
bin/prose-diff-client.ts
                     the diff page script, bundled by its server at startup
bin/prose-pty.py     runs hx in a pty for the editor pane
bin/lib/             CSS, and the conflict, event, conversation, session and theme modules,
                     and for diff reviews the patch, diff source and review modules
../lib/claude/session.ts
                     inbox socket posting, liveness and config dirs, shared with fleet
deno.jsonc           import map
deno.lock            locked dependency versions
skill/SKILL.md       the /prose skill
nvim/plugin/prose.lua  :Prose, :ProseStop, :ProseList and :ProseDiff
LICENSE              MIT license of the upstream code
SOURCE               upstream repo and commit
```

`bin/prose` and each script resolve their own folder through the `~/.local/bin/prose` symlink. Deno looks for `deno.jsonc` next to the script it runs, so a bare symlink to `prose.ts` fails with `Import "@std/path" not a dependency`.

The server reads its CSS and bundles the client once at startup. After editing anything under `bin/`, restart a server with `prose stop <port>` and start it again. A restart marks in-progress requests `interrupted`.

### Held requests and joining

A comment no session takes, because the server has no session or delivery fails, is marked held in its doc's log. The server sends held requests on its own, oldest first:

- ahead of the next comment that gets through
- every ten seconds while its session is up
- at once when a session joins

`prose join <file|port>`, run from a Claude Code session's Bash tool, points the server at that session for every open doc, passing the session's inbox socket and token from its environment. The token marks deliveries as the session's own, so they arrive with no prompt. Joining also takes over a server whose session ended, or one started for another session. Held markers live in the doc's log, so they survive a server restart.

A request a session already took is not sent again, and neither is work left `interrupted` when a session stopped mid-work. `prose pending` lists both. Logs written before held markers existed have none, so nothing old is resent.

## Following links

A link in a doc to another local markdown file opens that file in the same server, in place, so the browser's back and forward buttons work. The page sends every relative or absolute local link through `/follow`, which resolves it against the linking doc's folder:

- **Markdown:** a `.md` or `.markdown` file opens as another doc, at `/?file=<path>`. An `#anchor` in the link survives.
- **Media:** an image or video file is served raw through `/local`.
- **Anything else** gets a "markdown and media files only" message. Web links, mail links and in-page `#anchors` are left alone.

Each open doc has its own state: its text and file watcher, its edit notices, its comment log under `~/.local/state/prose/`, its conversation, and its Helix pane. Comments on any doc go to the server's one session, and each event's header names the doc's path and the command to reply:

```
Prose event for /path/to/sub/b.md (port 4933; handle per /prose skill; reply with prose respond /path/to/sub/b.md <phase> <request ids>):
```

The tooling works per doc:

- `prose respond <file>` names the doc. `prose respond <port>` finds the doc from the request ids.
- `prose pending <port>` lists the unfinished requests of every doc the server has open, each with its `file`.
- `prose port <file>` finds a followed doc's server through the server's `/docs` list.
- `prose stop` stops the whole server, with all its open docs.

A server opens only markdown under `$HOME` or beside its first file. It refuses a path that enters a dot folder, such as `.ssh` or `.config`, unless the first file's own path already passes through it. That exception is what lets a server started on a doc in `.claude/worktrees/<name>/` follow links within that worktree.

## Requests from the browser

The server listens on 127.0.0.1 and accepts browser requests only from its own page:

- **Origin:** a POST or WebSocket upgrade from another site has a foreign `Origin` and gets a 403.
- **Host:** a `Host` header other than `localhost:<port>` or `127.0.0.1:<port>` gets a 403, which blocks DNS rebinding.
- **`Sec-Fetch-Site`:** any value other than `same-origin` or `none` gets a 403. That covers what carries no `Origin`, such as another site linking your browser to `/?file=<any path>`. `none` is a URL you typed or `prose start` opened.
- **`/local`** serves media types only, from where docs may open, and sends a sandboxing `Content-Security-Policy`. An SVG opened directly can't run scripts on the server's origin, where they could post comments into the session.

curl and the `prose` tools send none of these browser headers, so they pass.

## Upstream

The server comes from `david-crespo/dotfiles` at the commit in `SOURCE`, under its MIT license. This copy has these changes:

- **Preview-only without Helix:** `prose.ts` checks for `hx` at startup. Without it, the server serves every page preview-only and refuses `/pty`.
- **Mermaid:** `prose-client.ts` renders `mermaid` fenced blocks as diagrams.
- **Theme:** `bin/lib/prose/theme.ts` and the buttons that force light or dark. See "Theme" under Concepts.
- **Liveness across config dirs:** `sessionAlive` checks every config dir listed under "Finding sessions" above. Upstream checks only `~/.claude`.
- **Shared session code:** `postToSession`, `sessionAlive` and `claudeDirs` live in `lib/claude/session.ts` at the dotfiles root, which fleet imports too. `bin/lib/prose/session.ts` re-exports them and keeps `resolveSession` and `formatForSession`. The shared module posts through `Deno.Command` in place of upstream's dax.
- **Many docs per server:** the per-file state moved from `prose.ts` into `Doc` and `DocSet` in `bin/lib/prose/docs.ts`. Every route takes `?file=`, `/follow` and `/docs` are new, and the client sends its doc's `file` on every request. See "Following links".
- **Request checks:** the `Sec-Fetch-Site` check, and the media-only, sandboxed `/local`. See "Requests from the browser". Both follow `david-crespo/ah`, the same author's newer project.
- **Reply hint:** each event's header names the `prose respond` command for its doc.
- **Held requests and `prose join`:** held and delivered records in `bin/lib/prose/events.ts`, sending in `Doc.comment` and `Doc.flushHeld`, and a `/session` route. See "Held requests and joining". The idea follows `ah`'s delivery records.

- **Diff reviews:** `prose-diff.ts`, `prose-diff-client.ts` and their `bin/lib/prose` modules (`patch.ts`, `diffsource.ts`, `review.ts`, `diff.css`). `prose-bg` takes `--server` and `--label` to start them. The `diff-comment` event kind and its anchor are in `events.ts`, and `conversation.ts` labels diff comments and sends the page's token. See "Diff reviews". Oxide's skepsis, which `ah` uses for diffs, is the model for the refresh bar and the viewed marks.

The entrypoint and every `bin/prose-*` shell script exist only here. To update from upstream, diff the upstream files at a new commit against the ones at `SOURCE`, apply that diff here, and update `SOURCE`.

## Related Claude Code docs

- [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging): inbox sockets, delivery, inbound controls, and limits
- [Skills](https://code.claude.com/docs/en/skills): how `/prose` loads
- [CLI reference](https://code.claude.com/docs/en/cli-reference): `--name`, used for the new pane's session
- [Settings reference](https://code.claude.com/docs/en/settings-reference#crosssessioninbound): `crossSessionInbound`
