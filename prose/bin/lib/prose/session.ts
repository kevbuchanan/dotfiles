// Delivery of prose events into the Claude Code session that launched the
// server. The socket, liveness and posting code is shared with fleet in
// lib/claude/session.ts at the dotfiles root; this module adds how prose
// picks its session and how it heads each delivery.

export { claudeDirs, postToSession, type Session, sessionAlive } from "../../../../lib/claude/session.ts"
import type { Session } from "../../../../lib/claude/session.ts"

// The socket comes from --socket, or else from the environment of the Claude
// Code session whose Bash tool started the server.
export function resolveSession(flag?: string): Session | null {
  const envSocket = Deno.env.get("CLAUDE_CODE_MESSAGING_SOCKET")
  const socket = flag ?? envSocket
  if (!socket) return null
  const token = socket === envSocket
    ? Deno.env.get("CLAUDE_CODE_MESSAGING_TOKEN")
    : undefined
  return { socket, token }
}

// The harness frames anything arriving on the socket as a message from
// another Claude session. The header is deliberately one line: the prose
// skill explains what these events are and how to reply, so repeating that
// on every delivery only pads the transcript.
export function formatForSession(file: string, port: number, events: string[]): string {
  return [
    `Prose event for ${file} (port ${port}; handle per /prose skill; reply with prose respond ${file} <phase> <request ids>):`,
    ...events,
  ].join("\n")
}
