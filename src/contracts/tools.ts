import type { Action } from './core.ts'

/** JSON Schema (draft 2020-12 subset) describing a tool's input object. */
export interface JsonSchemaObject {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolSpec {
  /** `^[a-z][a-z0-9_]{0,63}$` */
  name: string
  description: string
  inputSchema: JsonSchemaObject
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface ToolResult {
  output: string
  isError: boolean
}

export interface Tool {
  spec: ToolSpec
  /**
   * Describe the permission this call needs, or `null` if it is side-effect free
   * (e.g. reading the agent's own memory). Throws on invalid input.
   */
  describe(input: unknown): Omit<Action, 'agentId' | 'roomId'> | null
  run(input: unknown, signal: AbortSignal): Promise<ToolResult>
}

/** What a driver receives per turn. */
export interface ToolSet {
  specs: ToolSpec[]
  /** Validates, authorizes (rules → approvals) and runs. Never throws: failures become `isError` results. */
  invoke(call: ToolCall, signal: AbortSignal): Promise<ToolResult>
}

/** Per-agent `tools` service. Plugins register tools; registrations are removed when the plugin disposes. */
export interface ToolsService {
  register(tool: Tool): () => void
  list(): ToolSpec[]
  /** Snapshot bound to a turn (room id is attached to every Action). */
  forTurn(opts: { roomId?: string }): ToolSet
}

declare module 'cordis' {
  interface Context {
    tools: ToolsService
  }
}
