import { Context, type Fiber } from 'cordis'
import type {} from '../contracts/index.ts'
import type { WhalesConfig } from '../contracts/config.ts'
import { Store } from '../services/store-service.ts'
import { Agents } from '../services/agents.ts'
import { StubDriver } from '../drivers/stub.ts'
import { OpenAICompatDriver } from '../drivers/openai-compat.ts'
import { Rules } from '../services/rules.ts'
import { Approvals } from '../services/approvals.ts'
import { Memory } from '../services/memory.ts'
import { AgentSkills, SkillLibrary, type SkillsConfig } from '../services/skills.ts'
import { Routines, type RoutinesConfig } from '../services/routines.ts'
import { Workspace } from '../services/workspace.ts'
import { Rooms, type RoomsConfig } from '../services/rooms.ts'
import { RoomPlugins } from '../services/room-plugins.ts'
import { Market, type MarketConfig } from '../services/market.ts'
import { AgentCheckpoints, Checkpoints, type CheckpointsConfig } from '../services/checkpoints.ts'
import { TelegramBridge } from '../bridges/telegram.ts'

export interface App {
  ctx: Context
  stop(): Promise<void>
}

export interface AppOptions {
  config: WhalesConfig
  /** SQLite path; `':memory:'` for tests. */
  storePath: string
  /** Per-service config; `false` leaves a root service out (tests that install their own fakes). */
  services?: {
    skills?: SkillsConfig | false
    routines?: RoutinesConfig | false
    rooms?: RoomsConfig | false
    checkpoints?: CheckpointsConfig | false
    approvals?: false
    market?: MarketConfig | false
  }
}

/** Cordis `FiberState.ACTIVE` (ambient const enum, unusable under isolatedModules). */
const FIBER_ACTIVE = 2

type ChildFiber = { name: string; fiber: Fiber & PromiseLike<Fiber> }

/** Root plugin: every root service is a child of this fiber, so `stop()` is a single dispose. */
function Whales(ctx: Context, opts: AppOptions & { children: ChildFiber[] }): void {
  const add = (name: string, fiber: Fiber & PromiseLike<Fiber>) => opts.children.push({ name, fiber })
  ctx.provide('config', opts.config)
  add('store', ctx.plugin(Store, { path: opts.storePath }))
  add('agents', ctx.plugin(Agents))
  add('rules', ctx.plugin(Rules))
  const services = opts.services ?? {}
  if (services.approvals !== false) add('approvals', ctx.plugin(Approvals))
  if (services.skills !== false) add('skills', ctx.plugin(SkillLibrary, services.skills ?? {}))
  if (services.routines !== false) add('routines', ctx.plugin(Routines, services.routines ?? {}))
  if (services.rooms !== false) {
    add('rooms', ctx.plugin(Rooms, services.rooms ?? {}))
    add('roomPlugins', ctx.plugin(RoomPlugins))
  }
  if (services.checkpoints !== false) add('checkpoints', ctx.plugin(Checkpoints, services.checkpoints ?? {}))
  if (services.market !== false) add('market', ctx.plugin(Market, services.market ?? {}))
  ctx.inject(['agents'], (ctx) => {
    const builtins = {
      'driver-stub': StubDriver,
      'driver-openai-compat': OpenAICompatDriver,
      memory: Memory,
      skills: AgentSkills,
      workspace: Workspace,
      checkpoints: AgentCheckpoints,
      'bridge-telegram': TelegramBridge,
    }
    for (const [name, plugin] of Object.entries(builtins)) {
      ctx.effect(() => ctx.agents.catalog.register(name, plugin), `catalog:${name}`)
    }
  })
}

export async function createApp(opts: AppOptions): Promise<App> {
  const root = new Context()
  const children: ChildFiber[] = []
  const fiber: Fiber = await root.plugin(Whales, { ...opts, children })
  try {
    // Children with injected dependencies activate after their parent; wait for each one explicitly.
    for (let pass = 0; pass < 2; pass++) {
      for (const child of children) {
        try {
          await child.fiber
        } catch (err) {
          throw new Error(`whales: ${child.name} failed to start: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
        }
      }
    }
    const stuck = children.filter((child) => child.fiber.state !== FIBER_ACTIVE).map((child) => child.name)
    if (stuck.length) throw new Error(`whales: root services did not start: ${stuck.join(', ')}`)
    // Installed marketplace plugins must be in the catalog before anyone restores agents that use them.
    await (root.get('market') as Market | undefined)?.ready
  } catch (err) {
    await fiber.dispose()
    throw err
  }
  return { ctx: root, stop: () => fiber.dispose() }
}
