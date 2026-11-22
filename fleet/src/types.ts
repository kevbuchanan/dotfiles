// The closed sets fleet passes between its commands, panes and agents, and
// the parsers that admit a value from outside: tmux, the command line and
// files. A value read from one of those is checked once, here, so a typo in
// fleet's own code fails the build.

import { die } from "./run.ts"

export const oneOf = <T extends string>(values: readonly T[], value: string): value is T =>
  (values as readonly string[]).includes(value)

// A seat's @agent_state, which the pane border shows and seat commands check
export const SEAT_STATES = ["idle", "busy", "waiting", "stalled", "question", "restarting"] as const
export type SeatState = (typeof SEAT_STATES)[number]
export const isSeatState = (value: string): value is SeatState => oneOf(SEAT_STATES, value)

// The role a session plays. Each is also the name of the fleet skill that
// guides it.
export const ROLES = ["orchestrator", "worker", "pair"] as const
export type Role = (typeof ROLES)[number]
// The roles fleet launches seats for, and the skills fleet messages name
export type SeatRole = Exclude<Role, "pair">
export const SEAT_ROLES: readonly SeatRole[] = ["orchestrator", "worker"]

export function parseRole(value: string): Role {
  if (!oneOf(ROLES, value)) die(`a role is ${ROLES.join(", ")}: ${value}`)
  return value
}

// The prefix of a role's FLEET_<prefix>_MODEL and _EFFORT settings
export const SETTING_PREFIX = { orchestrator: "ORCH", worker: "WORKER" } as const satisfies Record<
  SeatRole,
  string
>

// The tmux options fleet keeps on a seat's pane
export const PANE_OPTIONS = [
  "@agent_seat",
  "@agent_cmd",
  "@agent_task",
  "@agent_state",
  "@agent_socket",
  "@agent_session",
] as const
export type PaneOption = (typeof PANE_OPTIONS)[number]

// A tmux pane id, %<n>. Only a parse of tmux's output, $TMUX_PANE or a
// --pane argument makes one, so a seat name or a session name can't stand in
// for a pane.
export type Pane = string & { readonly __pane: unique symbol }
export function asPane(value: string): Pane {
  if (!/^%\d+$/.test(value)) die(`not a tmux pane id: ${value || "(empty)"}`)
  return value as Pane
}

// The flags `fleet new` takes, and the FLEET_* variable each one sets
export const NEW_FLAGS = {
  "--agent": "FLEET_AGENT",
  "--workers": "FLEET_WORKERS",
  "--worker-mode": "FLEET_WORKER_MODE",
  "--orch-model": "FLEET_ORCH_MODEL",
  "--worker-model": "FLEET_WORKER_MODEL",
  "--orch-effort": "FLEET_ORCH_EFFORT",
  "--worker-effort": "FLEET_WORKER_EFFORT",
} as const
export type SettingName = (typeof NEW_FLAGS)[keyof typeof NEW_FLAGS]
// A fleet's settings, empty where unset
export type Settings = Record<SettingName, string>

export const isFlag = (value: string): value is keyof typeof NEW_FLAGS => Object.hasOwn(NEW_FLAGS, value)

// A role's model and effort settings
export function roleSettings(settings: Settings, role: SeatRole): { model: string; effort: string } {
  const prefix = SETTING_PREFIX[role]
  return { model: settings[`FLEET_${prefix}_MODEL`], effort: settings[`FLEET_${prefix}_EFFORT`] }
}

// The fleet commands the orchestrator may run without a prompt
export const ORCH_COMMANDS = [
  "status",
  "task",
  "assign",
  "clear",
  "interrupt",
  "rename",
  "path",
  "diff",
  "answer",
  "bump",
  "archive",
] as const
