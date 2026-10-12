import type { Context, Plugin } from 'cordis'
import type { AgentId, AgentSpec, Awaitable, RoomId, TurnId } from './core.ts'
import type { BaseRecord } from './store.ts'
import type { ChatMessage, DriverEvent } from './driver.ts'

/**
 * Service names that are isolated per agent (`ctx.isolate(name)` on the agent context).
 * A plugin in agent A that provides one of these is invisible to agent B and to the root.
 */
export const PER_AGENT_SERVICES = ['agent', 'driver', 'memory', 'tools'] as const

export interface PromptContext {
  agentId: AgentId
  turnId: TurnId
  prompt: string
  roomId?: RoomId
}

export interface PromptSection {
  /** Unique within the agent, e.g. `skills`, `memory`. */
  id: string
  /** Lower renders first. Persona = 0, skills = 100, memory = 200, room = 300. */
  order: number
  /** Return '' to contribute nothing this turn. */
  render(ctx: PromptContext): Awaitable<string>
}

export interface TurnOptions {
  roomId?: RoomId
  /** Overrides the agent's own DM history (rooms pass the room transcript). */
  history?: ChatMessage[]
  signal?: AbortSignal
}

/** The per-agent `agent` service: identity + turn execution. */
export interface AgentRuntime {
  readonly id: AgentId
  readonly spec: AgentSpec
  /** True while a turn is queued or running. Turns on one agent are serialised (FIFO). */
  readonly busy: boolean
  /** Registered sections are removed automatically when the registering plugin disposes. */
  addPromptSection(section: PromptSection): () => void
  /**
   * Run one turn: emits `whales/turn-before`, assembles the prompt, calls `ctx.driver.run`,
   * re-emits every event as `whales/agent-event`, persists the DM exchange (unless `roomId`),
   * emits `whales/turn-after`. The iterable always ends with `done`.
   */
  turn(prompt: string, opts?: TurnOptions): AsyncIterable<DriverEvent>
}

export type AgentState = 'starting' | 'active' | 'failed' | 'disposed'

export interface AgentHandle {
  readonly id: AgentId
  readonly spec: AgentSpec
  /** The agent's isolated context. Exposed for tests and the server; do not plug into it from outside. */
  readonly ctx: Context
  readonly state: AgentState
  /** Present once `state === 'active'`. */
  readonly runtime: AgentRuntime | undefined
  /** Last plugin error when `state === 'failed'`. */
  readonly error: Error | undefined
}

/** Maps `PluginRef.name` → plugin. Lives on the `agents` service. */
export interface PluginCatalog {
  register(name: string, plugin: Plugin): () => void
  resolve(name: string): Plugin | undefined
  names(): string[]
}

export interface AgentsService {
  readonly catalog: PluginCatalog
  /**
   * Validate the spec, fork an isolated context, install the `agent` runtime, `tools`, the driver, then
   * `spec.plugins` in order. Resolves once every plugin is active (or rejects and disposes on failure).
   * Persists the spec unless `persist: false`. Throws if the id is taken or a plugin name is unknown.
   */
  spawn(spec: AgentSpec, opts?: { persist?: boolean }): Promise<AgentHandle>
  get(id: AgentId): AgentHandle | undefined
  list(): AgentHandle[]
  /** Dispose the agent context (all its plugins, timers, sockets). `forget` also deletes its stored spec. */
  dispose(id: AgentId, opts?: { forget?: boolean }): Promise<boolean>
  /** Spawn every persisted agent. Failures are logged and reported, not thrown. */
  restore(): Promise<{ ok: AgentId[]; failed: { id: AgentId; error: string }[] }>
}

export interface AgentRecord extends BaseRecord {
  scope: 'global'
  spec: AgentSpec
}

/** One DM message, scope `agent:<id>`. */
export interface MessageRecord extends BaseRecord {
  turnId: TurnId
  role: 'user' | 'assistant'
  content: string
}

declare module './store.ts' {
  interface Collections {
    agents: AgentRecord
    messages: MessageRecord
  }
}

declare module 'cordis' {
  interface Context {
    agents: AgentsService
    agent: AgentRuntime
  }
}
