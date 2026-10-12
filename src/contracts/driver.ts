import type { RoomId, TurnId } from './core.ts'
import type { ToolSet } from './tools.ts'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** Speaker label in rooms (agent name or `user`). Drivers prefix it into content if the API lacks names. */
  name?: string
}

export interface TurnInput {
  turnId: TurnId
  roomId?: RoomId
  /** Fully assembled system prompt (persona + skills + memory + room context). */
  system: string
  /** Prior conversation, oldest first. Stateful drivers may ignore it. */
  history: ChatMessage[]
  /** The new user/room message for this turn. */
  prompt: string
  /** Tools the driver may call. Drivers without tool support ignore it. */
  tools: ToolSet
}

export type StopReason = 'end' | 'max_tokens' | 'cancelled' | 'refused' | 'error'

export type DriverEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  /** Emitted while the driver is blocked on a user approval (purely informational). */
  | { type: 'waiting_approval'; requestId: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
  /** Always the last event of a run, exactly once, even after `error` or abort. */
  | { type: 'done'; stopReason: StopReason }

export interface DriverCapabilities {
  /** Can call tools from `TurnInput.tools`. */
  tools: boolean
  /** Has its own file/shell access (agentic drivers like ACP). Its actions are gated via `approvals`. */
  agentic: boolean
  /** Keeps its own conversation state; `history` is only used to seed a fresh session. */
  statefulSession: boolean
}

/**
 * The per-agent `driver` service. Provided by exactly one driver plugin in the agent context.
 * Implementations: driver-stub, driver-openai-compat, driver-acp.
 */
export interface Driver {
  /** e.g. `openai-compat`. */
  readonly kind: string
  /** Model label for display / cost accounting. */
  readonly model: string
  readonly capabilities: DriverCapabilities
  /**
   * Run one turn. Must:
   * - stream events as they arrive, ending with exactly one `done`;
   * - stop promptly and emit `done{cancelled}` when `signal` aborts;
   * - never throw after the first yield: report failures as `error` then `done{error}`;
   * - never log or emit API keys.
   */
  run(input: TurnInput, signal: AbortSignal): AsyncIterable<DriverEvent>
}

declare module 'cordis' {
  interface Context {
    driver: Driver
  }
}
