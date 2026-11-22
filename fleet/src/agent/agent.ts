// The agent that runs in fleet's seats. fleet's tasks, notes, git and tmux
// work the same for any agent; these are the operations that depend on
// which one runs. Each agent reports its session's state with `fleet
// signal`: Claude Code through its hooks, opencode through fleet's watcher.

import type { Fleet } from "../fleet.ts"
import { die } from "../run.ts"
import type { Pane, SeatRole, Settings } from "../types.ts"
import * as claude from "./claude.ts"
import * as opencode from "./opencode.ts"

export type Setup = {
  // fleet's own folder, for the plugin and the hooks
  root: string
  // the fleet's state folder, where the rendered settings go
  rundir: string
  notes: string
  // the fleet's repos besides the one its seats start in
  others: string[]
  settings: Settings
}

// Each seat role's launch command, given the seat's name
export type SeatCommands = Record<SeatRole, (name: string) => string>

export type PairLaunch = { root: string; name: string; notes: string; prompt: string }

export interface Agent {
  name: AgentName
  // refuses settings it can't run with, before fleet makes anything
  check(settings: Settings): void
  // renders what the seats run with and returns each role's launch command
  prepare(setup: Setup): Promise<SeatCommands>
  // a seat's launch line with one more folder its session may edit
  addDir(cmd: string, path: string): string
  // creates <repo>/.claude/worktrees/<name> and returns its branch
  createWorktree(repo: string, name: string): Promise<string>
  // the first line of every fleet message, naming the skill that handles it
  header(sender: string, skill: SeatRole): string
  // whether the session in pane can take a message
  ready(pane: Pane): Promise<boolean>
  deliver(pane: Pane, message: string): Promise<void>
  // a fresh context, after which the session reports `fleet signal start`
  reset(pane: Pane): Promise<void>
  interrupt(pane: Pane): Promise<void>
  // a pairing window's agent pane: its command, and the environment for the
  // window's panes from the orchestrator's launch line
  pairCommand(pair: PairLaunch): string
  paneEnv(orchCmd: string): string[]
  // runs once the fleet's seats are launched, for anything the agent needs
  // beside them
  started(fleet: Fleet, dir: string): Promise<void>
}

export const AGENT_NAMES = ["claude", "opencode"] as const
export type AgentName = (typeof AGENT_NAMES)[number]

// Each module checks against Agent here, so one missing an operation fails
// the build
export const agents: Record<AgentName, Agent> = { claude, opencode }

const isAgentName = (value: string): value is AgentName => Object.hasOwn(agents, value)

// The agent of that name, claude by default
export function agentNamed(name: string): Agent {
  const key = name || "claude"
  if (!isAgentName(key)) die(`unknown agent ${name}; fleet runs ${Object.keys(agents).join(" or ")}`)
  return agents[key]
}
