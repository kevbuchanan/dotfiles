// Claude Code cross-session messaging, shared by prose and fleet. Every
// session binds an inbox socket (a Unix domain socket) and exports its path
// to child processes as CLAUDE_CODE_MESSAGING_SOCKET. Writing one JSON line
// to the socket wakes an idle session or is read between tool calls in a
// busy one. Docs: code.claude.com/docs/en/cross-session-messaging ("The
// session's inbox socket").
//
// Imports use jsr: specifiers, so the module resolves under prose's and
// fleet's import maps alike.

import { basename, join } from "jsr:@std/path@^1.0.8"

export type Session = {
  socket: string
  // Exported alongside the socket; sending it as an auth line lets the
  // session verify the post came from its own child even after process
  // evidence is gone. Only meaningful for the socket from the environment.
  token?: string
}

// A session's registry entry, <config dir>/sessions/<pid>.json, exists only
// while it runs; the socket file itself can outlive the process. A session
// started with CLAUDE_CONFIG_DIR registers under that folder, so every config
// dir in claudeDirs() is probed. Sync so callers can use it in a snapshot
// without plumbing promises through.
export function sessionAlive(session: Session | null): boolean {
  if (!session) return false
  const pid = basename(session.socket).match(/^(\d+)\.sock$/)?.[1]
  const probes = pid
    ? claudeDirs().map((dir) => join(dir, "sessions", `${pid}.json`))
    : [session.socket]
  return probes.some((probe) => {
    try {
      Deno.statSync(probe)
      return true
    } catch {
      return false
    }
  })
}

// ~/.claude, $CLAUDE_CONFIG_DIR, and the colon-separated $PROSE_CLAUDE_DIRS.
// prose-session reads the same list to find sessions by name or tmux window.
export function claudeDirs(): string[] {
  const env = (k: string) => Deno.env.get(k) ?? ""
  return [
    join(env("HOME"), ".claude"),
    env("CLAUDE_CONFIG_DIR"),
    ...env("PROSE_CLAUDE_DIRS").split(":"),
  ].filter((d, i, all) => d && all.indexOf(d) === i)
}

// nc rather than Deno.connect: Deno gates Unix sockets behind --allow-net
// with the exact path, which varies per session pid. Open only once the
// message is ready: the session drops connections that go 30s without a
// complete line. macOS nc has no shutdown-on-EOF flag and blocks until the
// peer closes; the session closes right after reading the line, but -w
// bounds the wait in case it ever doesn't.
export async function postToSession(session: Session, text: string): Promise<void> {
  const lines = []
  if (session.token) lines.push(JSON.stringify({ type: "auth", token: session.token }))
  lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }))
  const child = new Deno.Command("nc", {
    args: ["-w", "2", "-U", session.socket],
    stdin: "piped",
    stdout: "null",
    stderr: "piped",
  }).spawn()
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(lines.join("\n") + "\n"))
  await writer.close()
  const { code, stderr } = await child.output()
  if (code !== 0) {
    throw new Error(`nc exited ${code}: ${new TextDecoder().decode(stderr).trim()}`)
  }
}
