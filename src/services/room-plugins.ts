import { Service, type Context, type Fiber } from 'cordis'
import type { AgentHandle } from '../contracts/agents.ts'
import type { AgentId, RoomId } from '../contracts/core.ts'
import type { RoomPluginStatus } from '../contracts/rooms.ts'
import { ROOM_SCOPE } from '../core/scope.ts'

/** Cordis `FiberState.ACTIVE`. */
const FIBER_ACTIVE = 2

interface Loaded {
  handle: AgentHandle
  /** JSON of the plugin config, so a config change reloads the plugin. */
  config: string
  fiber: Fiber
  status: RoomPluginStatus
}

/**
 * SECURITY (orchestrator-owned). Root `roomPlugins` service: keeps every room's plugins loaded in each running member,
 * on a branch of the member's context marked with ROOM_SCOPE, so their tools/prompt sections only appear in that room's
 * turns (tools still go through the member's approvals; rooms always ask). Reconciles on room changes and agent
 * spawn/dispose. A plugin that fails to load is reported in `status()`; it never takes the agent down.
 */
export class RoomPlugins extends Service {
  static inject = ['agents', 'rooms']

  private own: Context
  private loaded = new Map<string, Loaded>()
  private queue: Promise<void> = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'roomPlugins')
    this.own = ctx
    ctx.on('whales/room-changed', () => void this.sync())
    ctx.on('whales/agent-spawned', () => void this.sync())
    ctx.on('whales/agent-disposed', () => void this.sync())
    ctx.on('whales/catalog-changed', () => void this.sync())
    ctx.effect(() => () => {
      for (const entry of this.loaded.values()) void entry.fiber.dispose()
      this.loaded.clear()
    }, 'room-plugins')
    void this.sync()
  }

  status(roomId?: RoomId): RoomPluginStatus[] {
    return [...this.loaded.values()].map((e) => e.status).filter((s) => roomId === undefined || s.roomId === roomId)
  }

  /** Bring loaded plugins in line with the stored rooms. Serialised; resolves once this pass is done. */
  sync(): Promise<void> {
    this.queue = this.queue.then(() => this.reconcile()).catch((err) => {
      this.own.logger('room-plugins').warn('sync failed: %s', err instanceof Error ? err.message : String(err))
    })
    return this.queue
  }

  private async reconcile(): Promise<void> {
    const agents = this.own.agents
    const wanted = new Map<string, { roomId: RoomId; agentId: AgentId; name: string; config: Record<string, unknown> | undefined }>()
    for (const room of this.own.rooms.list()) {
      for (const ref of room.plugins ?? []) {
        for (const agentId of room.members) {
          wanted.set(key(room.id, agentId, ref.name), { roomId: room.id, agentId, name: ref.name, config: ref.config })
        }
      }
    }

    for (const [k, entry] of this.loaded) {
      const want = wanted.get(k)
      const current = agents.get(entry.status.agentId)
      const stale = !want || entry.status.state === 'failed' || current !== entry.handle || current.state !== 'active' || JSON.stringify(want.config ?? null) !== entry.config
      if (stale) {
        this.loaded.delete(k)
        await entry.fiber.dispose()
      }
    }

    for (const [k, want] of wanted) {
      if (this.loaded.has(k)) continue
      const handle = agents.get(want.agentId)
      if (!handle || handle.state !== 'active') continue
      const status: RoomPluginStatus = { roomId: want.roomId, agentId: want.agentId, plugin: want.name, state: 'active' }
      const plugin = agents.catalog.resolve(want.name)
      if (!plugin) {
        // Uninstalled while still listed on the room: report it, load nothing.
        this.loaded.set(k, { handle, config: JSON.stringify(want.config ?? null), fiber: inertFiber, status: { ...status, state: 'failed', error: 'plugin is not installed' } })
        continue
      }
      const scoped = handle.ctx.extend({ [ROOM_SCOPE]: want.roomId } as {})
      const fiber = scoped.plugin(plugin, want.config)
      const entry: Loaded = { handle, config: JSON.stringify(want.config ?? null), fiber, status }
      this.loaded.set(k, entry)
      try {
        await fiber
        if (fiber.state !== FIBER_ACTIVE) throw new Error('plugin did not start (missing services?)')
      } catch (err) {
        entry.status = { ...status, state: 'failed', error: err instanceof Error ? err.message : String(err) }
        await fiber.dispose()
      }
    }
  }
}

const inertFiber = { dispose: async () => {} } as unknown as Fiber

function key(roomId: RoomId, agentId: AgentId, plugin: string): string {
  return `${roomId}\0${agentId}\0${plugin}`
}

declare module 'cordis' {
  interface Context {
    roomPlugins: RoomPlugins
  }
}
