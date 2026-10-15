import { Service, type Context, type Fiber, type Plugin } from 'cordis'
import type { AgentId, AgentSpec, PermissionMode, PluginRef } from '../contracts/core.ts'
import {
  PER_AGENT_SERVICES,
  type AgentHandle,
  type AgentRuntime,
  type AgentState,
  type AgentsService,
  type PluginCatalog,
  type PromptSection,
  type TurnOptions,
} from '../contracts/agents.ts'
import type { ChatMessage, DriverEvent, TurnInput } from '../contracts/driver.ts'
import type { ToolSet } from '../contracts/tools.ts'
import type { TurnInfo } from '../contracts/events.ts'
import { assertAgentId, newId } from '../core/ids.ts'
import { ToolsRegistry } from './tools.ts'
import { parseRule } from './rules.ts'
import { roomScopeOf } from '../core/scope.ts'

/** Cordis `FiberState.ACTIVE`. The enum is an ambient const enum, unusable under isolatedModules. */
const FIBER_ACTIVE = 2
const HISTORY_LIMIT = 40
const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'strict', 'trusted', 'edits', 'auto']

export class Catalog implements PluginCatalog {
  private plugins = new Map<string, Plugin>()

  register(name: string, plugin: Plugin): () => void {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new TypeError(`catalog: invalid plugin name ${JSON.stringify(name)}`)
    if (this.plugins.has(name)) throw new Error(`catalog: plugin "${name}" is already registered`)
    this.plugins.set(name, plugin)
    return () => {
      if (this.plugins.get(name) === plugin) this.plugins.delete(name)
    }
  }

  resolve(name: string): Plugin | undefined {
    return this.plugins.get(name)
  }

  names(): string[] {
    return [...this.plugins.keys()].sort()
  }
}

function isPluginRef(value: unknown): value is PluginRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const ref = value as Record<string, unknown>
  if (typeof ref.name !== 'string' || ref.name === '') return false
  return ref.config === undefined || (typeof ref.config === 'object' && ref.config !== null && !Array.isArray(ref.config))
}

const SECRET_KEY = /key|token|secret|password/i

/** Path of the first string value stored under a secret-looking key (keys ending in 'Env' are names, not values). */
export function findSecret(value: unknown, path: string): string | undefined {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const found = findSecret(item, `${path}[${i}]`)
      if (found) return found
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && SECRET_KEY.test(key) && !key.endsWith('Env')) return `${path}.${key}`
      const found = findSecret(child, `${path}.${key}`)
      if (found) return found
    }
  }
  return undefined
}

export function validateSpec(spec: AgentSpec): void {
  assertAgentId(spec.id)
  const fail = (field: string, problem: string): never => {
    throw new TypeError(`agent ${spec.id}: ${field} ${problem}`)
  }
  if (typeof spec.name !== 'string' || spec.name.trim() === '') fail('name', 'must be a non-empty string')
  if (typeof spec.seniority !== 'number' || !Number.isFinite(spec.seniority)) fail('seniority', 'must be a finite number')
  if (spec.role !== undefined && typeof spec.role !== 'string') fail('role', 'must be a string')
  if (spec.instructions !== undefined && typeof spec.instructions !== 'string') fail('instructions', 'must be a string')
  if (!isPluginRef(spec.driver)) fail('driver', 'must be { name, config? }')
  if (!Array.isArray(spec.plugins) || !spec.plugins.every(isPluginRef)) fail('plugins', 'must be an array of { name, config? }')
  if (spec.rules !== undefined && (!Array.isArray(spec.rules) || !spec.rules.every((r) => typeof r === 'string'))) {
    fail('rules', 'must be an array of strings')
  }
  const secret = findSecret({ driver: spec.driver, plugins: spec.plugins }, 'spec')
  if (secret) fail(secret, 'looks like a secret; store keys in environment variables and reference them by name (e.g. apiKeyEnv)')
  for (const sentence of spec.rules ?? []) {
    try {
      parseRule(sentence)
    } catch (err) {
      fail('rules', `contains an invalid rule: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (spec.permissionMode !== undefined && !PERMISSION_MODES.includes(spec.permissionMode)) {
    fail('permissionMode', `must be one of ${PERMISSION_MODES.join(', ')}`)
  }
  if (spec.workdir !== undefined && (typeof spec.workdir !== 'string' || !spec.workdir.startsWith('/'))) {
    fail('workdir', 'must be an absolute path')
  }
}

class Handle implements AgentHandle {
  state: AgentState = 'starting'
  runtime: AgentRuntime | undefined = undefined
  error: Error | undefined = undefined
  ctx!: Context
  fiber: Fiber | undefined = undefined
  readonly id: AgentId
  readonly spec: AgentSpec

  constructor(spec: AgentSpec) {
    this.id = spec.id
    this.spec = spec
  }
}

/** Installed in each agent context first; provides the per-agent `agent` service. */
export class Runtime extends Service implements AgentRuntime {
  static inject = ['store']

  readonly id: AgentId
  readonly spec: AgentSpec
  /** The agent's own context. `this.ctx` is the *caller's* context inside methods (Cordis tracing). */
  private actx: Context
  /** Keyed by section id; room-scoped sections (from room plugins) are keyed `<roomId>\0<id>`. */
  private sections = new Map<string, { section: PromptSection; roomId: string | undefined }>()
  private tail: Promise<void> = Promise.resolve()
  /** Turns requested and not yet finished (queued + running). */
  private pending = 0
  /** Last createdAt written to `messages`, so persisted history is strictly ordered. */
  private lastPersisted = 0

  constructor(ctx: Context, spec: AgentSpec) {
    super(ctx, 'agent')
    this.actx = ctx
    this.id = spec.id
    this.spec = spec
  }

  get busy(): boolean {
    return this.pending > 0
  }

  addPromptSection(section: PromptSection): () => void {
    const roomId = roomScopeOf(this.ctx)
    const key = roomId === undefined ? section.id : `${roomId}\0${section.id}`
    if (this.sections.has(key)) throw new Error(`agent ${this.id}: prompt section "${section.id}" already registered`)
    const entry = { section, roomId }
    const dispose = this.ctx.effect(() => {
      this.sections.set(key, entry)
      return () => {
        if (this.sections.get(key) === entry) this.sections.delete(key)
      }
    }, `prompt-section:${section.id}`)
    return () => void dispose()
  }

  async *turn(prompt: string, opts: TurnOptions = {}): AsyncIterable<DriverEvent> {
    this.pending++
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => (release = resolve))
    await previous
    const info: TurnInfo = { agentId: this.id, turnId: newId('turn'), prompt }
    if (opts.roomId !== undefined) info.roomId = opts.roomId
    const signal = opts.signal ?? new AbortController().signal
    let output = ''
    let ok = false
    try {
      await this.actx.serial('whales/turn-before', info)
      for await (const event of this.drive(info, prompt, opts, signal)) {
        if (event.type === 'text') output += event.delta
        if (event.type === 'done') ok = event.stopReason === 'end'
        this.actx.emit('whales/agent-event', { ...info, event })
        yield event
      }
      if (ok && opts.roomId === undefined) this.persistExchange(info, output)
      await this.actx.serial('whales/turn-after', { ...info, ok, output })
    } finally {
      this.pending--
      release()
    }
  }

  /** Calls the driver and enforces the contract: stops after `done`, always ends with exactly one `done`. */
  private async *drive(info: TurnInfo, prompt: string, opts: TurnOptions, signal: AbortSignal): AsyncGenerator<DriverEvent> {
    const driver = this.actx.get('driver')
    if (!driver) {
      yield { type: 'error', message: `agent ${this.id}: no driver is active` }
      yield { type: 'done', stopReason: 'error' }
      return
    }
    let input: TurnInput
    try {
      input = {
        turnId: info.turnId,
        system: await this.buildSystem(info),
        history: opts.history ?? this.loadHistory(),
        prompt,
        tools: this.actx.get('tools')?.forTurn(opts.roomId === undefined ? {} : { roomId: opts.roomId }) ?? EMPTY_TOOLS,
      }
      if (info.roomId !== undefined) input.roomId = info.roomId
    } catch (err) {
      yield { type: 'error', message: `agent ${this.id}: failed to prepare turn: ${errorMessage(err)}` }
      yield { type: 'done', stopReason: 'error' }
      return
    }
    try {
      for await (const event of driver.run(input, signal)) {
        yield event
        if (event.type === 'done') return
      }
      yield { type: 'error', message: `driver ${driver.kind} ended without a done event` }
      yield { type: 'done', stopReason: 'error' }
    } catch (err) {
      yield { type: 'error', message: `driver ${driver.kind} failed: ${errorMessage(err)}` }
      yield { type: 'done', stopReason: signal.aborted ? 'cancelled' : 'error' }
    }
  }

  private async buildSystem(info: TurnInfo): Promise<string> {
    const { name, role, instructions } = this.spec
    const parts = [role ? `You are ${name}, ${role}.` : `You are ${name}.`]
    if (instructions) parts.push(instructions)
    const sections = [...this.sections.values()]
      .filter((entry) => entry.roomId === undefined || entry.roomId === info.roomId)
      .map((entry) => entry.section)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    const promptCtx = { agentId: info.agentId, turnId: info.turnId, prompt: info.prompt, ...(info.roomId === undefined ? {} : { roomId: info.roomId }) }
    for (const section of sections) {
      try {
        const text = (await section.render(promptCtx)).trim()
        if (text) parts.push(text)
      } catch (err) {
        this.actx.logger('agent').warn('agent %s: prompt section %s failed: %s', this.id, section.id, errorMessage(err))
      }
    }
    return parts.join('\n\n')
  }

  private loadHistory(): ChatMessage[] {
    const messages = this.actx.store.collection('messages').list({ scope: `agent:${this.id}`, order: 'desc', limit: HISTORY_LIMIT })
    return messages.reverse().map(({ role, content }) => ({ role, content }))
  }

  private persistExchange(info: TurnInfo, output: string): void {
    const store = this.actx.store
    const messages = store.collection('messages')
    if (this.lastPersisted === 0) {
      this.lastPersisted = messages.list({ scope: `agent:${this.id}`, order: 'desc', limit: 1 })[0]?.createdAt ?? 0
    }
    const now = Math.max(Date.now(), this.lastPersisted + 1)
    this.lastPersisted = now + 1
    store.transaction(() => {
      messages.put({ id: newId('msg'), scope: `agent:${this.id}`, createdAt: now, turnId: info.turnId, role: 'user', content: info.prompt })
      messages.put({ id: newId('msg'), scope: `agent:${this.id}`, createdAt: now + 1, turnId: info.turnId, role: 'assistant', content: output })
    })
  }
}

const EMPTY_TOOLS: ToolSet = {
  specs: [],
  invoke: async (call) => ({ output: `tool ${call.name} is not available`, isError: true }),
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface AgentPluginConfig {
  handle: Handle
  driver: Plugin
  plugins: { ref: PluginRef; plugin: Plugin }[]
  children: { name: string; fiber: Fiber & PromiseLike<Fiber> }[]
  onDispose: () => void
}

/** The agent itself is a plugin: disposing its fiber tears down everything below. */
function AgentPlugin(ctx: Context, config: AgentPluginConfig): void {
  let actx = ctx
  for (const name of PER_AGENT_SERVICES) actx = actx.isolate(name)
  const { handle, children } = config
  handle.ctx = actx
  ctx.effect(() => config.onDispose, 'agent-lifecycle')
  children.push({ name: 'agent', fiber: actx.plugin(Runtime, handle.spec) })
  children.push({ name: 'tools', fiber: actx.plugin(ToolsRegistry) })
  children.push({ name: handle.spec.driver.name, fiber: actx.plugin(config.driver, handle.spec.driver.config) })
  for (const { ref, plugin } of config.plugins) {
    children.push({ name: ref.name, fiber: actx.plugin(plugin, ref.config) })
  }
}

export class Agents extends Service implements AgentsService {
  static inject = ['store']

  readonly catalog = new Catalog()
  private handles = new Map<AgentId, Handle>()
  private root: Context

  constructor(ctx: Context) {
    super(ctx, 'agents')
    this.root = ctx
  }

  async spawn(input: AgentSpec, opts: { persist?: boolean } = {}): Promise<AgentHandle> {
    validateSpec(input)
    const spec = structuredClone(input)
    if (this.handles.has(spec.id)) throw new Error(`agent ${spec.id} already exists`)
    const resolve = (ref: PluginRef) => {
      const plugin = this.catalog.resolve(ref.name)
      if (!plugin) throw new Error(`agent ${spec.id}: unknown plugin "${ref.name}"`)
      return plugin
    }
    const driver = resolve(spec.driver)
    const plugins = spec.plugins.map((ref) => ({ ref, plugin: resolve(ref) }))

    const handle = new Handle(spec)
    this.handles.set(spec.id, handle)
    const children: AgentPluginConfig['children'] = []
    const onDispose = () => {
      handle.state = 'disposed'
      handle.runtime = undefined
      if (this.handles.get(spec.id) === handle) {
        this.handles.delete(spec.id)
        this.root.emit('whales/agent-disposed', spec.id)
      }
    }
    const fiber = this.root.plugin(AgentPlugin, { handle, driver, plugins, children, onDispose })
    handle.fiber = fiber
    try {
      await fiber
      // Two passes: a plugin that injects a service provided by a later plugin activates after it.
      for (let pass = 0; pass < 2; pass++) {
        for (const child of children) {
          try {
            await child.fiber
          } catch (err) {
            throw new Error(`agent ${spec.id}: plugin "${child.name}" failed: ${errorMessage(err)}`, { cause: err })
          }
        }
      }
      const stuck = children.filter((child) => child.fiber.state !== FIBER_ACTIVE)
      if (stuck.length) {
        const detail = stuck.map((c) => `"${c.name}" (waiting for: ${Object.keys(c.fiber.inject).join(', ') || 'unknown'})`)
        throw new Error(`agent ${spec.id}: plugins did not start: ${detail.join('; ')}`)
      }
      const runtime = handle.ctx.get('agent')
      if (!runtime) throw new Error(`agent ${spec.id}: runtime did not start`)
      handle.runtime = runtime
      handle.state = 'active'
    } catch (err) {
      handle.error = err instanceof Error ? err : new Error(String(err))
      this.handles.delete(spec.id)
      await fiber.dispose()
      handle.state = 'failed'
      throw handle.error
    }
    if (opts.persist !== false) {
      this.root.store.collection('agents').put({ id: spec.id, scope: 'global', createdAt: Date.now(), spec })
    }
    this.root.emit('whales/agent-spawned', handle)
    return handle
  }

  async update(input: AgentSpec): Promise<AgentHandle | undefined> {
    validateSpec(input)
    const spec = structuredClone(input)
    const agents = this.root.store.collection('agents')
    const record = agents.get(spec.id)
    const running = this.handles.get(spec.id)
    if (!record && !running) throw new Error(`agent ${spec.id} does not exist`)
    for (const ref of [spec.driver, ...spec.plugins]) {
      if (!this.catalog.resolve(ref.name)) throw new Error(`agent ${spec.id}: unknown plugin "${ref.name}"`)
    }
    const save = () => agents.put({ id: spec.id, scope: 'global', createdAt: record?.createdAt ?? Date.now(), spec })
    if (!running) {
      save()
      return undefined
    }
    const old = running.spec
    await this.dispose(spec.id)
    try {
      const handle = await this.spawn(spec, { persist: false })
      save()
      return handle
    } catch (err) {
      try {
        await this.spawn(old, { persist: false })
      } catch (restoreErr) {
        this.root.logger('agents').warn('agent %s: could not restart with its previous spec: %s', spec.id, errorMessage(restoreErr))
      }
      throw err
    }
  }

  get(id: AgentId): AgentHandle | undefined {
    return this.handles.get(id)
  }

  list(): AgentHandle[] {
    return [...this.handles.values()]
  }

  async dispose(id: AgentId, opts: { forget?: boolean } = {}): Promise<boolean> {
    const handle = this.handles.get(id)
    if (!handle?.fiber) return false
    await handle.fiber.dispose()
    if (opts.forget) {
      const store = this.root.store
      store.transaction(() => {
        store.collection('agents').delete(id)
        store.collection('messages').clear(`agent:${id}`)
      })
    }
    return true
  }

  async restore(): Promise<{ ok: AgentId[]; failed: { id: AgentId; error: string }[] }> {
    const ok: AgentId[] = []
    const failed: { id: AgentId; error: string }[] = []
    for (const record of this.root.store.collection('agents').list()) {
      if (this.handles.has(record.id)) continue
      try {
        await this.spawn(record.spec, { persist: false })
        ok.push(record.id)
      } catch (err) {
        failed.push({ id: record.id, error: errorMessage(err) })
        this.root.logger('agents').warn('restore %s failed: %s', record.id, errorMessage(err))
      }
    }
    return { ok, failed }
  }
}
