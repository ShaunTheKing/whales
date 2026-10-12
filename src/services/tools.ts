import { Service, type Context } from 'cordis'
import type { PermissionMode } from '../contracts/core.ts'
import type { Tool, ToolCall, ToolResult, ToolSet, ToolSpec, ToolsService } from '../contracts/tools.ts'
import { isToolName } from '../core/ids.ts'
import { roomScopeOf } from '../core/scope.ts'

/**
 * Per-agent `tools` service. SECURITY: `invoke` is the only path from a model to a tool's side effects.
 * Every call with a non-null `describe()` goes through `approvals.authorize`; if no approvals service is
 * running, side-effecting calls are refused (fail closed).
 */
export class ToolsRegistry extends Service implements ToolsService {
  /** Tools available in every turn. */
  private tools = new Map<string, Tool>()
  /** Room-scoped tools (registered by room plugins), only offered in that room's turns. */
  private roomTools = new Map<string, Map<string, Tool>>()
  /** The agent context; `this.ctx` is the caller's context inside methods. */
  private actx: Context

  constructor(ctx: Context) {
    super(ctx, 'tools')
    this.actx = ctx
  }

  /** The registration is removed when the calling plugin disposes, or when the returned function runs. */
  register(tool: Tool): () => void {
    const name = tool.spec.name
    if (!isToolName(name)) throw new TypeError(`tools: invalid tool name ${JSON.stringify(name)}`)
    const roomId = roomScopeOf(this.ctx)
    // Within one scope names are unique. A room tool may share a name with an agent-wide tool: forTurn prefers the
    // agent-wide one (e.g. the same plugin enabled on the agent and on the room).
    const taken = roomId === undefined ? this.tools.has(name) : this.roomTools.get(roomId)?.has(name)
    if (taken) throw new Error(`tools: "${name}" is already registered`)
    const dispose = this.ctx.effect(() => {
      const map = roomId === undefined ? this.tools : this.roomMap(roomId)
      map.set(name, tool)
      return () => {
        if (map.get(name) === tool) map.delete(name)
        if (roomId !== undefined && map.size === 0 && this.roomTools.get(roomId) === map) this.roomTools.delete(roomId)
      }
    }, `tool:${name}`)
    return () => void dispose()
  }

  list(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => tool.spec)
  }

  forTurn(opts: { roomId?: string }): ToolSet {
    // Snapshot: a room tool whose name clashes with an agent-wide tool is skipped (agent-wide wins).
    const visible = new Map(this.tools)
    if (opts.roomId !== undefined) {
      for (const [name, tool] of this.roomTools.get(opts.roomId) ?? []) if (!visible.has(name)) visible.set(name, tool)
    }
    return {
      specs: [...visible.values()].map((tool) => tool.spec),
      invoke: (call, signal) => this.invoke(call, signal, visible, opts.roomId),
    }
  }

  private roomMap(roomId: string): Map<string, Tool> {
    let map = this.roomTools.get(roomId)
    if (!map) this.roomTools.set(roomId, (map = new Map()))
    return map
  }

  private async invoke(call: ToolCall, signal: AbortSignal, visible: Map<string, Tool>, roomId: string | undefined): Promise<ToolResult> {
    const fail = (output: string): ToolResult => ({ output, isError: true })
    const tool = visible.get(call.name)
    if (!tool) return fail(`unknown tool: ${call.name}`)
    if (signal.aborted) return fail('cancelled')

    let action
    try {
      action = tool.describe(call.input)
    } catch (err) {
      return fail(`invalid input for ${call.name}: ${errorMessage(err)}`)
    }

    if (action !== null) {
      const agent = this.actx.get('agent')
      const approvals = this.actx.get('approvals')
      if (!agent) return fail('permission denied: agent runtime is not active')
      if (!approvals) return fail('permission denied: no approval service is running')
      const mode: PermissionMode = agent.spec.permissionMode ?? this.actx.get('config')?.defaults.permissionMode ?? 'ask'
      try {
        const auth = await approvals.authorize(
          { ...action, agentId: agent.id, ...(roomId === undefined ? {} : { roomId }) },
          { mode, signal },
        )
        if (!auth.allowed) return fail(`permission denied: ${auth.reason}`)
      } catch (err) {
        return fail(`permission check failed: ${errorMessage(err)}`)
      }
    }

    try {
      return await tool.run(call.input, signal)
    } catch (err) {
      return fail(`${call.name} failed: ${errorMessage(err)}`)
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
