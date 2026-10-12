import { Context, type Fiber } from 'cordis'
import type {} from '../contracts/index.ts'
import type { WhalesConfig } from '../contracts/config.ts'
import { Store } from '../services/store-service.ts'
import { Agents } from '../services/agents.ts'
import { StubDriver } from '../drivers/stub.ts'
import { OpenAICompatDriver } from '../drivers/openai-compat.ts'

export interface App {
  ctx: Context
  stop(): Promise<void>
}

export interface AppOptions {
  config: WhalesConfig
  /** SQLite path; `':memory:'` for tests. */
  storePath: string
}

/** Root plugin: every root service is a child of this fiber, so `stop()` is a single dispose. */
function Whales(ctx: Context, opts: AppOptions): void {
  ctx.provide('config', opts.config)
  ctx.plugin(Store, { path: opts.storePath })
  ctx.plugin(Agents)
  ctx.inject(['agents'], (ctx) => {
    ctx.effect(() => ctx.agents.catalog.register('driver-stub', StubDriver), 'catalog:driver-stub')
    ctx.effect(() => ctx.agents.catalog.register('driver-openai-compat', OpenAICompatDriver), 'catalog:driver-openai-compat')
  })
}

export async function createApp(opts: AppOptions): Promise<App> {
  const root = new Context()
  const fiber: Fiber = await root.plugin(Whales, opts)
  if (!root.get('agents')) {
    await fiber.dispose()
    throw new Error('whales: core services failed to start')
  }
  return { ctx: root, stop: () => fiber.dispose() }
}
