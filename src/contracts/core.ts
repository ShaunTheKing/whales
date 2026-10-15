// Shared primitive types. Owned by the orchestrator: workers must not edit contracts/.

export type Awaitable<T> = T | Promise<T>

/** `^[a-z0-9][a-z0-9-]{0,31}$` — validated by `agents.spawn`. */
export type AgentId = string
export type RoomId = string
export type TurnId = string

/** Storage / ownership scope. `global`, `agent:<id>` or `room:<id>`. */
export type Scope = 'global' | `agent:${AgentId}` | `room:${RoomId}`

/** A JSON-serialisable reference to a plugin in the catalog (see agents.ts). */
export interface PluginRef {
  name: string
  config?: Record<string, unknown>
}

/**
 * - `ask`     (default) rule `allow` → allow, no match → ask the user.
 * - `strict`  like `ask`, but rule `allow` is ignored: everything not denied asks.
 * - `trusted` no match → allow. `deny` / `ask` rules still apply.
 * - `edits`   like `ask`, but file reads/writes inside the workdir are allowed, rooms included.
 * - `auto`    everything not denied or asked by a rule is allowed, rooms included.
 * In a room, `ask`/`strict`/`trusted` behave as `ask` and rule `allow` is downgraded to `ask`.
 * Paths outside the workdir always ask, in every mode.
 */
export type PermissionMode = 'ask' | 'strict' | 'trusted' | 'edits' | 'auto'

export interface AgentSpec {
  id: AgentId
  /** Display name. */
  name: string
  /** One-line role, folded into the system prompt. */
  role?: string
  /** Free-form persona / instructions, folded into the system prompt. */
  instructions?: string
  /** Higher is more senior. The most senior member of a room speaks last and arbitrates. */
  seniority: number
  /** Exactly one driver plugin; it must provide the `driver` service. */
  driver: PluginRef
  /** Other per-agent plugins (memory, skills, tools, bridges, ...), installed in order. */
  plugins: PluginRef[]
  /** Sentence-style rules scoped to this agent (see rules.ts). */
  rules?: string[]
  permissionMode?: PermissionMode
  /** Absolute path. Defaults to `<dataDir>/workspaces/<id>`. File tools are confined to it. */
  workdir?: string
  /** Set when the agent was hired by another agent. */
  hiredBy?: AgentId
}

export type ActionKind =
  | 'file.read'
  | 'file.write'
  | 'shell'
  | 'network'
  | 'tool'
  | 'message'
  | 'skill.install'
  | 'agent.hire'

/** Something an agent wants to do. Evaluated by rules, then (maybe) approved by the user. */
export interface Action {
  kind: ActionKind
  /** What the action touches: a path (relative to workdir), a command line, a URL, a tool name, ... */
  target: string
  agentId: AgentId
  roomId?: RoomId
  /** Human-readable one-liner for approval cards. */
  summary: string
  /** Extra structured detail for the UI (diff, full input, ...). Never secrets. */
  detail?: unknown
}

export type Verdict = 'allow' | 'deny' | 'ask'
