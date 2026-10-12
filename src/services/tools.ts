import { Service, type Context } from 'cordis'
import type { PermissionMode } from '../contracts/core.ts'
import type { Tool, ToolCall, ToolResult, ToolSet, ToolSpec, ToolsService } from '../contracts/tools.ts'
import { isToolName } from '../core/ids.ts'

/**
 * Per-agent `tools` service. SECURITY: `invoke` is the only path from a model to a tool's side effects.
 * Every call with a non-null `describe()` goes through `approvals.authorize`; if no approvals service is
 * running, side-effecting calls are refused (fail closed).
 */
export class ToolsRegistry extends Service implements ToolsService {
  private tools = new Map<string, Tool>()
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
    if (this.tools.has(name)) throw new Error(`tools: "${name}" is already registered`)
    const dispose = this.ctx.effect(() => {
      this.tools.set(name, tool)
      return () => {
        if (this.tools.get(name) === tool) this.tools.delete(name)
      }
    }, `tool:${name}`)
    return () => void dispose()
  }

  list(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => tool.spec)
  }

  forTurn(opts: { roomId?: string }): ToolSet {
    const specs = this.list()
    const allowed = new Set(specs.map((spec) => spec.name))
    return {
      specs,
      invoke: (call, signal) => this.invoke(call, signal, allowed, opts.roomId),
    }
  }

  private async invoke(call: ToolCall, signal: AbortSignal, allowed: Set<string>, roomId: string | undefined): Promise<ToolResult> {
    const fail = (output: string): ToolResult => ({ output, isError: true })
    const tool = allowed.has(call.name) ? this.tools.get(call.name) : undefined
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
