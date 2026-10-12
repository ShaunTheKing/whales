import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from 'cordis'
import { createApp, type App } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import type { Driver, DriverCapabilities, DriverEvent, TurnInput } from '../../src/contracts/driver.ts'
import type { AgentSpec } from '../../src/contracts/core.ts'
import type {} from '../../src/contracts/index.ts'

/** Records the tool names and system prompt of every turn. */
const seen: { agent: string; roomId: string | undefined; tools: string[]; system: string }[] = []

class SeeDriver extends Service implements Driver {
  readonly kind = 'see'
  readonly model = 'see'
  readonly capabilities: DriverCapabilities = { tools: true, agentic: false, statefulSession: false }
  private agentName: string
  constructor(ctx: Context, config: { agent: string }) {
    super(ctx, 'driver')
    this.agentName = config.agent
  }
  async *run(input: TurnInput): AsyncIterable<DriverEvent> {
    seen.push({ agent: this.agentName, roomId: input.roomId, tools: input.tools.specs.map((s) => s.name), system: input.system })
    yield { type: 'text', delta: 'ok' }
    yield { type: 'done', stopReason: 'end' }
  }
}

/** A marketplace-style plugin: plain object, registers a tool and a prompt section. */
const DicePlugin = {
  name: 'dice',
  inject: ['tools', 'agent'],
  apply(ctx: Context, config: { sides?: number } = {}) {
    ctx.tools.register({
      spec: { name: 'roll_dice', description: 'roll', inputSchema: { type: 'object', properties: {} } },
      describe: () => null,
      run: async () => ({ output: String(config.sides ?? 6), isError: false }),
    })
    ctx.agent.addPromptSection({ id: 'dice', order: 500, render: () => `DICE-${config.sides ?? 6}` })
  },
}

const FailingPlugin = {
  name: 'boom',
  apply() {
    throw new Error('kaboom')
  },
}

function spec(id: string, plugins: AgentSpec['plugins'] = []): AgentSpec {
  return { id, name: id, seniority: 1, driver: { name: 'see', config: { agent: id } }, plugins }
}

async function setup(t: { after(fn: () => Promise<void>): void }): Promise<App> {
  const dataDir = await mkdtemp(join(tmpdir(), 'whales-roomplugins-'))
  const app = await createApp({ config: { ...defaultConfig(), dataDir }, storePath: ':memory:', services: { checkpoints: false, routines: false } })
  t.after(async () => {
    await app.stop()
    await rm(dataDir, { recursive: true, force: true })
  })
  app.ctx.agents.catalog.register('see', SeeDriver)
  app.ctx.agents.catalog.register('dice', DicePlugin)
  app.ctx.agents.catalog.register('boom', FailingPlugin)
  return app
}

async function drain(iter: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iter) void _
}

test('room plugins: tools and prompt sections exist only in that room’s turns', async (t) => {
  const app = await setup(t)
  const a = await app.ctx.agents.spawn(spec('ann'))
  await app.ctx.agents.spawn(spec('bob'))
  const room1 = app.ctx.rooms.create({ name: 'one', members: ['ann', 'bob'] })
  const room2 = app.ctx.rooms.create({ name: 'two', members: ['ann'] })
  app.ctx.rooms.setPlugins(room1.id, [{ name: 'dice', config: { sides: 20 } }])
  await app.ctx.roomPlugins.sync()
  assert.deepEqual(app.ctx.roomPlugins.status(room1.id).map((s) => [s.agentId, s.state]).sort(), [['ann', 'active'], ['bob', 'active']])

  seen.length = 0
  await drain(app.ctx.rooms.post(room1.id, 'hi'))
  await drain(app.ctx.rooms.post(room2.id, 'hi'))
  await drain(a.runtime!.turn('dm'))
  const inRoom1 = seen.filter((s) => s.roomId === room1.id)
  assert.equal(inRoom1.length, 2)
  for (const s of inRoom1) {
    assert.deepEqual(s.tools, ['roll_dice'])
    assert.match(s.system, /DICE-20/)
  }
  for (const s of seen.filter((s) => s.roomId !== room1.id)) {
    assert.deepEqual(s.tools, [], `${s.agent} in ${s.roomId ?? 'DM'} must not see room1 tools`)
    assert.doesNotMatch(s.system, /DICE/)
  }
})

test('room plugins: removing the plugin or the member unloads it; config change reloads', async (t) => {
  const app = await setup(t)
  const ann = await app.ctx.agents.spawn(spec('ann'))
  await app.ctx.agents.spawn(spec('bob'))
  const room = app.ctx.rooms.create({ name: 'r', members: ['ann', 'bob'] })
  app.ctx.rooms.setPlugins(room.id, [{ name: 'dice' }])
  await app.ctx.roomPlugins.sync()
  app.ctx.rooms.removeMember(room.id, 'bob')
  await app.ctx.roomPlugins.sync()
  assert.deepEqual(app.ctx.roomPlugins.status(room.id).map((s) => s.agentId), ['ann'])

  app.ctx.rooms.setPlugins(room.id, [{ name: 'dice', config: { sides: 4 } }])
  await app.ctx.roomPlugins.sync()
  const tools = ann.ctx.get('tools')!.forTurn({ roomId: room.id })
  assert.equal((await tools.invoke({ id: '1', name: 'roll_dice', input: {} }, new AbortController().signal)).output, '4')

  app.ctx.rooms.setPlugins(room.id, [])
  await app.ctx.roomPlugins.sync()
  assert.deepEqual(app.ctx.roomPlugins.status(room.id), [])
  assert.deepEqual(ann.ctx.get('tools')!.forTurn({ roomId: room.id }).specs, [])
})

test('room plugins: follow agents across restarts; a failing plugin is reported, agent keeps working', async (t) => {
  const app = await setup(t)
  await app.ctx.agents.spawn(spec('ann'))
  const room = app.ctx.rooms.create({ name: 'r', members: ['ann'] })
  app.ctx.rooms.setPlugins(room.id, [{ name: 'dice' }, { name: 'boom' }])
  await app.ctx.roomPlugins.sync()
  const status = app.ctx.roomPlugins.status(room.id)
  assert.equal(status.find((s) => s.plugin === 'boom')?.state, 'failed')
  assert.match(status.find((s) => s.plugin === 'boom')?.error ?? '', /kaboom/)
  assert.equal(app.ctx.agents.get('ann')?.state, 'active')

  await app.ctx.agents.dispose('ann')
  await app.ctx.roomPlugins.sync()
  assert.deepEqual(app.ctx.roomPlugins.status(room.id), [])
  const again = await app.ctx.agents.spawn(spec('ann'), { persist: false })
  await app.ctx.roomPlugins.sync()
  assert.deepEqual(again.ctx.get('tools')!.forTurn({ roomId: room.id }).specs.map((s) => s.name), ['roll_dice'])
})

test('room plugins: validation', async (t) => {
  const app = await setup(t)
  await app.ctx.agents.spawn(spec('ann'))
  const room = app.ctx.rooms.create({ name: 'r', members: ['ann'] })
  assert.throws(() => app.ctx.rooms.setPlugins(room.id, [{ name: 'nope' }]), /unknown plugin/)
  assert.throws(() => app.ctx.rooms.setPlugins(room.id, [{ name: 'memory' }]), /cannot be used as a room plugin/)
  assert.throws(() => app.ctx.rooms.setPlugins(room.id, [{ name: 'dice' }, { name: 'dice' }]), /duplicate/)
  assert.throws(() => app.ctx.rooms.setPlugins(room.id, [{ name: 'dice', config: { apiKey: 'sk-x' } }]), /secret/)
})

test('agent-wide tools win over a same-named room tool; same room plugin in two rooms does not clash', async (t) => {
  const app = await setup(t)
  const ann = await app.ctx.agents.spawn(spec('ann'))
  const r1 = app.ctx.rooms.create({ name: 'a', members: ['ann'] })
  const r2 = app.ctx.rooms.create({ name: 'b', members: ['ann'] })
  app.ctx.rooms.setPlugins(r1.id, [{ name: 'dice', config: { sides: 1 } }])
  app.ctx.rooms.setPlugins(r2.id, [{ name: 'dice', config: { sides: 2 } }])
  await app.ctx.roomPlugins.sync()
  const signal = new AbortController().signal
  const call = { id: '1', name: 'roll_dice', input: {} }
  assert.equal((await ann.ctx.get('tools')!.forTurn({ roomId: r1.id }).invoke(call, signal)).output, '1')
  assert.equal((await ann.ctx.get('tools')!.forTurn({ roomId: r2.id }).invoke(call, signal)).output, '2')
  assert.equal((await ann.ctx.get('tools')!.forTurn({}).invoke(call, signal)).isError, true)
})

test('agents.update swaps plugins live and rolls back on failure', async (t) => {
  const app = await setup(t)
  await app.ctx.agents.spawn(spec('ann'))
  const updated = await app.ctx.agents.update(spec('ann', [{ name: 'dice' }]))
  assert.deepEqual(updated?.ctx.get('tools')!.list().map((s) => s.name), ['roll_dice'])
  assert.deepEqual(app.ctx.store.collection('agents').get('ann')?.spec.plugins, [{ name: 'dice' }])

  await assert.rejects(app.ctx.agents.update(spec('ann', [{ name: 'boom' }])), /kaboom/)
  const back = app.ctx.agents.get('ann')
  assert.equal(back?.state, 'active')
  assert.deepEqual(back?.spec.plugins, [{ name: 'dice' }])
  assert.deepEqual(app.ctx.store.collection('agents').get('ann')?.spec.plugins, [{ name: 'dice' }])
  await assert.rejects(app.ctx.agents.update(spec('ghost')), /does not exist/)
})
