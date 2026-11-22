// The agent that runs in fleet's seats. fleet's tasks, notes, git and tmux
// work the same for any agent; these are the operations that depend on
// which one runs. Claude Code is the only implementation. Another agent
// reports its session's state with `fleet signal`, as Claude Code's hooks
// do.

import * as claude from "./claude.ts"

export type { SeatCommands, Setup } from "./claude.ts"
import type { SeatCommands, Setup } from "./claude.ts"

export interface Agent {
  name: string
  // refuses FLEET_* settings it can't run with, before fleet makes anything
  check(settings: Record<string, string>): void
  // renders what the seats run with and returns each role's launch command
  prepare(setup: Setup): Promise<SeatCommands>
  // a seat's launch line with one more folder its session may edit
  addDir(cmd: string, path: string): string
  // creates <repo>/.claude/worktrees/<name> and returns its branch
  createWorktree(repo: string, name: string): Promise<string>
  // the first line of every fleet message
  header(sender: string, skill: string): string
  // whether the session in pane can take a message
  ready(pane: string): Promise<boolean>
  deliver(pane: string, message: string): Promise<void>
  // a fresh context, after which the session reports `fleet signal start`
  reset(pane: string): Promise<void>
  interrupt(pane: string): Promise<void>
  // a pairing window's agent pane: its command, and the environment for the
  // window's panes from the orchestrator's launch line
  pairCommand(root: string, name: string, notes: string, prompt: string): string
  paneEnv(orchCmd: string): string[]
}

export const agent: Agent = claude
