import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Service } from 'cordis'
import type { Context } from 'cordis'
import type {} from '../../src/contracts/index.ts'
import type { AgentSpec, AgentId } from '../../src/contracts/core.ts'
import type { Driver, DriverEvent, TurnInput } from '../../src/contracts/driver.ts'
import type { MemoryService } from '../../src/contracts/memory.ts'
import { createApp } from '../../src/core/app.ts'
import type { App } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import { validateSpec } from '../../src/services/agents.ts'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface Harness {
  app: App
  home: string
}

const harnesses: Harness[] = []

async function makeApp(): Promise<Harness> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whales-agents-'))
  const app = await createApp({
    config: defaultConfig({ home, cwd: home }),
    storePath: ':memory:',
  })
  const h: Harness = { app, home }
  harnesses.push(h)
  return h
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()
    if (!h) continue
    try {
      await h.app.stop()
    } catch {
      // ignore
    }
    try {
      fs.rmSync(h.home, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

function baseSpec(id: string, over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id,
    name: id,
    seniority: 1,
    driver: { name: 'driver-stub' },
    plugins: [],
    ...over,
  }
}

async function collect(iter: AsyncIterable<DriverEvent>): Promise<DriverEvent[]> {
  const out: DriverEvent[] = []
  for await (const e of iter) out.push(e)
  return out
}

function textOf(events: DriverEvent[]): string {
  let s = ''
  for (const e of events) if (e.type === 'text') s += e.delta
  return s
}

function doneOf(events: DriverEvent[]): Extract<DriverEvent, { type: 'done' }> | undefined {
  const last = events.at(-1)
  if (last && last.type === 'done') return last
  return undefined
}

// ---------------------------------------------------------------------------
// validateSpec
// ---------------------------------------------------------------------------

describe('validateSpec', () => {
  test('accepts a minimal valid spec', () => {
    assert.doesNotThrow(() => validateSpec(baseSpec('ok')))
  })

  test('accepts a full valid spec', () => {
    const spec: AgentSpec = {
      id: 'full',
      name: 'Full Agent',
      role: 'tester',
      instructions: 'be nice',
      seniority: 5,
      driver: { name: 'driver-stub', config: { model: 'x' } },
      plugins: [{ name: 'driver-stub' }],
      rules: ['always be kind'],
      permissionMode: 'trusted',
      workdir: '/tmp/whales-full',
      hiredBy: 'boss',
    }
    assert.doesNotThrow(() => validateSpec(spec))
  })

  test('rejects bad ids', () => {
    assert.throws(() => validateSpec(baseSpec('Bad Id')), TypeError)
    assert.throws(() => validateSpec(baseSpec('')), TypeError)
    assert.throws(() => validateSpec(baseSpec('a'.repeat(33))), TypeError)
  })

  test('rejects empty name', () => {
    assert.throws(() => validateSpec(baseSpec('n1', { name: '' })), TypeError)
  })

  test('rejects non-finite seniority', () => {
    assert.throws(() => validateSpec(baseSpec('s1', { seniority: Number.NaN })), TypeError)
    assert.throws(() => validateSpec(baseSpec('s2', { seniority: Number.POSITIVE_INFINITY })), TypeError)
  })

  test('rejects driver without name', () => {
    const spec = baseSpec('d1')
    // @ts-expect-error intentionally invalid
    spec.driver = {}
    assert.throws(() => validateSpec(spec), TypeError)
  })

  test('rejects plugins that are not an array', () => {
    const spec = baseSpec('p1')
    // @ts-expect-error intentionally invalid
    spec.plugins = 'nope'
    assert.throws(() => validateSpec(spec), TypeError)
  })

  test('rejects a plugin entry with array config', () => {
    const spec = baseSpec('p2', {
      // @ts-expect-error intentionally invalid
      plugins: [{ name: 'driver-stub', config: [] }],
    })
    assert.throws(() => validateSpec(spec), TypeError)
  })

  test('rejects rules containing a non-string', () => {
    const spec = baseSpec('r1')
    // @ts-expect-error intentionally invalid
    spec.rules = ['ok', 42]
    assert.throws(() => validateSpec(spec), TypeError)
  })

  test('rejects permissionMode yolo', () => {
    const spec = baseSpec('m1')
    // @ts-expect-error intentionally invalid
    spec.permissionMode = 'yolo'
    assert.throws(() => validateSpec(spec), TypeError)
  })

  test('rejects relative workdir', () => {
    assert.throws(() => validateSpec(baseSpec('w1', { workdir: 'rel/dir' })), TypeError)
  })
})

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

describe('spawn persistence', () => {
  test('persists the spec unless persist:false', async () => {
    const { app } = await makeApp()
    const spec = baseSpec('persisted', { name: 'Persisted' })
    const handle = await app.ctx.agents.spawn(spec)
    const rec = app.ctx.store.collection('agents').get('persisted')
    assert.ok(rec)
    assert.equal(rec.id, 'persisted')
    assert.equal(rec.scope, 'global')
    assert.deepEqual(rec.spec, spec)
    assert.deepEqual(handle.spec, spec)

    const spec2 = baseSpec('ephemeral')
    await app.ctx.agents.spawn(spec2, { persist: false })
    assert.equal(app.ctx.store.collection('agents').get('ephemeral'), undefined)
  })

  test('stored spec is a copy of the input', async () => {
    const { app } = await makeApp()
    const spec = baseSpec('copy', { name: 'Original' })
    const handle = await app.ctx.agents.spawn(spec)
    spec.name = 'Mutated'
    assert.equal(handle.spec.name, 'Original')
    const rec = app.ctx.store.collection('agents').get('copy')
    assert.ok(rec)
    assert.equal(rec.spec.name, 'Original')
  })
})

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe('dispose', () => {
  test('dispose keeps the record, forget removes it and its messages', async () => {
    const { app } = await makeApp()
    await app.ctx.agents.spawn(baseSpec('d-keep'))
    assert.equal(await app.ctx.agents.dispose('d-keep'), true)
    assert.ok(app.ctx.store.collection('agents').get('d-keep'))

    await app.ctx.agents.spawn(baseSpec('d-forget'))
    const events = await collect(app.ctx.agents.get('d-forget')!.runtime!.turn('hi'))
    assert.equal(doneOf(events)?.stopReason, 'end')
    assert.equal(app.ctx.store.collection('messages').count({ scope: 'agent:d-forget' }), 2)

    assert.equal(await app.ctx.agents.dispose('d-forget', { forget: true }), true)
    assert.equal(app.ctx.store.collection('agents').get('d-forget'), undefined)
    assert.equal(app.ctx.store.collection('messages').count({ scope: 'agent:d-forget' }), 0)
  })
})

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

describe('restore', () => {
  test('re-spawns persisted agents not currently active', async () => {
    const { app } = await makeApp()
    await app.ctx.agents.spawn(baseSpec('r1'))
    await app.ctx.agents.spawn(baseSpec('r2'))
    await app.ctx.agents.dispose('r1')
    assert.equal(app.ctx.agents.get('r1'), undefined)

    const res = await app.ctx.agents.restore()
    assert.deepEqual(res.failed, [])
    assert.ok(res.ok.includes('r1'))
    assert.ok(app.ctx.agents.get('r1'))
  })

  test('reports agents with unknown plugins as failed without throwing', async () => {
    const { app } = await makeApp()
    const ghostSpec = baseSpec('ghost', {
      plugins: [{ name: 'no-such-plugin' }],
    })
    app.ctx.store.collection('agents').put({
      id: 'ghost',
      scope: 'global',
      createdAt: Date.now(),
      spec: ghostSpec,
    })

    const res = await app.ctx.agents.restore()
    assert.equal(res.ok.includes('ghost'), false)
    const failed = res.failed.find((f) => f.id === 'ghost')
    assert.ok(failed)
    assert.equal(typeof failed.error, 'string')
    assert.ok(failed.error.length > 0)
  })
})

// ---------------------------------------------------------------------------
// plugin startup failures
// ---------------------------------------------------------------------------

describe('plugin startup failures', () => {
  test('throwing plugin rejects spawn and cleans up earlier resources', async () => {
    const { app } = await makeApp()
    let counter = 0
    const earlier = {
      name: 'earlier',
      apply(ctx: Context) {
        ctx.effect(() => {
          const t = setInterval(() => {
            counter += 1
          }, 5)
          return () => clearInterval(t)
        })
      },
    }
    const thrower = {
      name: 'thrower',
      apply() {
        throw new Error('boom')
      },
    }
    app.ctx.agents.catalog.register('earlier', earlier)
    app.ctx.agents.catalog.register('thrower', thrower)

    await assert.rejects(
      () => app.ctx.agents.spawn(baseSpec('fail', { plugins: [{ name: 'earlier' }, { name: 'thrower' }] })),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.ok(err.message.includes('thrower'))
        return true
      },
    )
    assert.equal(app.ctx.agents.get('fail'), undefined)

    await sleep(30)
    const frozen = counter
    await sleep(30)
    assert.equal(counter, frozen)
  })

  test('inject of a missing service rejects with did not start', async () => {
    const { app } = await makeApp()
    const needsMemory = {
      name: 'needs-memory',
      inject: ['memory'],
      apply(ctx: Context) {
        void ctx.memory
      },
    }
    app.ctx.agents.catalog.register('needs-memory', needsMemory)

    await assert.rejects(
      () => app.ctx.agents.spawn(baseSpec('nomem', { plugins: [{ name: 'needs-memory' }] })),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.ok(err.message.includes('did not start'))
        assert.ok(err.message.includes('memory'))
        return true
      },
    )
  })

  test('inject before provider still spawns successfully', async () => {
    const { app } = await makeApp()
    class FakeMemory extends Service {
      constructor(ctx: Context) {
        super(ctx, 'memory')
      }
      remember(_scope: string, _text: string): string {
        return 'ok'
      }
      recall(_scope: string): string[] {
        return []
      }
    }
    const consumer = {
      name: 'mem-consumer',
      inject: ['memory'],
      apply(ctx: Context) {
        void ctx.memory
      },
    }
    const provider = {
      name: 'mem-provider',
      apply(ctx: Context) {
        ctx.plugin(FakeMemory)
      },
    }
    app.ctx.agents.catalog.register('mem-consumer', consumer)
    app.ctx.agents.catalog.register('mem-provider', provider)

    const handle = await app.ctx.agents.spawn(
      baseSpec('mem', { plugins: [{ name: 'mem-consumer' }, { name: 'mem-provider' }] }),
    )
    assert.equal(handle.state, 'active')
    assert.ok(handle.runtime)
  })
})

// ---------------------------------------------------------------------------
// runtime.turn
// ---------------------------------------------------------------------------

describe('runtime.turn', () => {
  test('streams text, ends with one done, persists DM exchange', async () => {
    const { app } = await makeApp()
    const handle = await app.ctx.agents.spawn(baseSpec('turn1'))
    assert.ok(handle.runtime)
    const events = await collect(handle.runtime.turn('hello'))
    const dones = events.filter((e) => e.type === 'done')
    assert.equal(dones.length, 1)
    assert.equal(doneOf(events)?.stopReason, 'end')
    assert.equal(textOf(events), 'echo: hello')

    const msgs = app.ctx.store.collection('messages').list({ scope: 'agent:turn1' })
    assert.equal(msgs.length, 2)
    const first = msgs[0]
    const second = msgs[1]
    assert.ok(first)
    assert.ok(second)
    assert.equal(first.role, 'user')
    assert.equal(first.content, 'hello')
    assert.equal(second.role, 'assistant')
    assert.equal(second.content, 'echo: hello')
    assert.equal(first.turnId, second.turnId)
  })

  test('room turn persists nothing', async () => {
    const { app } = await makeApp()
    const handle = await app.ctx.agents.spawn(baseSpec('turn2'))
    assert.ok(handle.runtime)
    const events = await collect(handle.runtime.turn('hi', { roomId: 'r1' }))
    assert.equal(doneOf(events)?.stopReason, 'end')
    assert.equal(app.ctx.store.collection('messages').count({ scope: 'agent:turn2' }), 0)
  })

  test('pre-aborted signal yields done{cancelled} and persists nothing', async () => {
    const { app } = await makeApp()
    const handle = await app.ctx.agents.spawn(baseSpec('turn3'))
    assert.ok(handle.runtime)
    const ac = new AbortController()
    ac.abort()
    const events = await collect(handle.runtime.turn('nope', { signal: ac.signal }))
    assert.equal(doneOf(events)?.stopReason, 'cancelled')
    assert.equal(app.ctx.store.collection('messages').count({ scope: 'agent:turn3' }), 0)
  })
})

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

describe('history', () => {
  test('DM history is passed to the driver', async () => {
    const { app } = await makeApp()
    const seen: TurnInput[] = []
    class SpyDriver extends Service {
      constructor(ctx: Context) {
        super(ctx, 'driver')
      }
      readonly kind = 'spy'
      readonly model = 'spy'
      readonly capabilities = { tools: false, agentic: false, statefulSession: false }
      async *run(input: TurnInput): AsyncIterable<DriverEvent> {
        seen.push(input)
        yield { type: 'text', delta: 'ok' }
        yield { type: 'done', stopReason: 'end' }
      }
    }
    app.ctx.agents.catalog.register('driver-spy', SpyDriver)

    const handle = await app.ctx.agents.spawn(baseSpec('hist', { driver: { name: 'driver-spy' } }))
    assert.ok(handle.runtime)
    await collect(handle.runtime.turn('one'))
    await collect(handle.runtime.turn('two'))
    await collect(handle.runtime.turn('three'))

    const third = seen[2]
    assert.ok(third)
    assert.deepEqual(third.history, [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'ok' },
    ])
  })

  test('explicit history option is passed through', async () => {
    const { app } = await makeApp()
    const seen: TurnInput[] = []
    class SpyDriver extends Service {
      constructor(ctx: Context) {
        super(ctx, 'driver')
      }
      readonly kind = 'spy'
      readonly model = 'spy'
      readonly capabilities = { tools: false, agentic: false, statefulSession: false }
      async *run(input: TurnInput): AsyncIterable<DriverEvent> {
        seen.push(input)
        yield { type: 'text', delta: 'ok' }
        yield { type: 'done', stopReason: 'end' }
      }
    }
    app.ctx.agents.catalog.register('driver-spy', SpyDriver)

    const handle = await app.ctx.agents.spawn(baseSpec('hist2', { driver: { name: 'driver-spy' } }))
    assert.ok(handle.runtime)
    const custom = [{ role: 'user' as const, content: 'seed' }]
    await collect(handle.runtime.turn('x', { history: custom }))
    const first = seen[0]
    assert.ok(first)
    assert.deepEqual(first.history, custom)
  })
})

// ---------------------------------------------------------------------------
// system prompt
// ---------------------------------------------------------------------------

describe('system prompt', () => {
  test('includes persona and instructions', async () => {
    const { app } = await makeApp()
    const seen: TurnInput[] = []
    class SpyDriver extends Service {
      constructor(ctx: Context) {
        super(ctx, 'driver')
      }
      readonly kind = 'spy'
      readonly model = 'spy'
      readonly capabilities = { tools: false, agentic: false, statefulSession: false }
      async *run(input: TurnInput): AsyncIterable<DriverEvent> {
        seen.push(input)
        yield { type: 'text', delta: 'ok' }
        yield { type: 'done', stopReason: 'end' }
      }
    }
    app.ctx.agents.catalog.register('driver-spy', SpyDriver)

    const handle = await app.ctx.agents.spawn(
      baseSpec('sys', {
        driver: { name: 'driver-spy' },
        name: 'Alice',
        role: 'helper',
        instructions: 'be concise',
      }),
    )
    assert.ok(handle.runtime)
    await collect(handle.runtime.turn('hi'))
    const input = seen[0]
    assert.ok(input)
    assert.ok(input.system.startsWith('You are Alice, helper.'))
    assert.ok(input.system.includes('be concise'))
  })

  test('prompt sections render in ascending order and can be removed', async () => {
    const { app } = await makeApp()
    const seen: TurnInput[] = []
    class SpyDriver extends Service {
      constructor(ctx: Context) {
        super(ctx, 'driver')
      }
      readonly kind = 'spy'
      readonly model = 'spy'
      readonly capabilities = { tools: false, agentic: false, statefulSession: false }
      async *run(input: TurnInput): AsyncIterable<DriverEvent> {
        seen.push(input)
        yield { type: 'text', delta: 'ok' }
        yield { type: 'done', stopReason: 'end' }
      }
    }
    app.ctx.agents.catalog.register('driver-spy', SpyDriver)

    let remove: (() => void) | undefined
    const sectionPlugin = {
      name: 'sections',
      inject: ['agent'],
      apply(ctx: Context) {
        ctx.agent.addPromptSection({ id: 'b', order: 200, render: () => 'SECOND' })
        ctx.agent.addPromptSection({ id: 'a', order: 100, render: () => 'FIRST' })
        ctx.agent.addPromptSection({ id: 'empty', order: 150, render: () => '' })
        ctx.agent.addPromptSection({
          id: 'boom',
          order: 120,
          render: () => {
            throw new Error('render fail')
          },
        })
        remove = ctx.agent.addPromptSection({ id: 'gone', order: 300, render: () => 'REMOVABLE' })
      },
    }
    app.ctx.agents.catalog.register('sections', sectionPlugin)

    const handle = await app.ctx.agents.spawn(
      baseSpec('sec', { driver: { name: 'driver-spy' }, plugins: [{ name: 'sections' }] }),
    )
    assert.ok(handle.runtime)
    await collect(handle.runtime.turn('hi'))
    const input = seen[0]
    assert.ok(input)
    const iFirst = input.system.indexOf('FIRST')
    const iSecond = input.system.indexOf('SECOND')
    assert.ok(iFirst >= 0)
    assert.ok(iSecond >= 0)
    assert.ok(iFirst < iSecond)
    assert.ok(input.system.includes('REMOVABLE'))

    assert.ok(remove)
    remove()
    await collect(handle.runtime.turn('again'))
    const input2 = seen[1]
    assert.ok(input2)
    assert.equal(input2.system.includes('REMOVABLE'), false)
    assert.ok(input2.system.includes('FIRST'))
  })
})

// ---------------------------------------------------------------------------
// turn serialisation
// ---------------------------------------------------------------------------

describe('turn serialisation', () => {
  test('turns on one agent run FIFO and busy reflects state', async () => {
    const { app } = await makeApp()
    const handle = await app.ctx.agents.spawn(
      baseSpec('serial', {
        driver: { name: 'driver-stub', config: { delayMs: 10, template: 'r{prompt}' } },
      }),
    )
    assert.ok(handle.runtime)
    const runtime = handle.runtime

    const order: string[] = []
    async function consume(prompt: string): Promise<void> {
      for await (const e of runtime.turn(prompt)) {
        if (e.type === 'text') order.push(prompt)
      }
    }

    const p1 = consume('A')
    const p2 = consume('B')
    assert.equal(runtime.busy, true)
    await Promise.all([p1, p2])
    assert.equal(runtime.busy, false)

    const firstB = order.indexOf('B')
    const lastA = order.lastIndexOf('A')
    assert.ok(lastA >= 0)
    assert.ok(firstB >= 0)
    assert.ok(lastA < firstB)
  })
})

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

describe('events', () => {
  test('turn-before / turn-after fire once with matching turnId', async () => {
    const { app } = await makeApp()
    const handle = await app.ctx.agents.spawn(baseSpec('ev1'))
    assert.ok(handle.runtime)

    const befores: string[] = []
    const afters: { turnId: string; ok: boolean; output: string }[] = []
    app.ctx.on('whales/turn-before', (t) => {
      befores.push(t.turnId)
    })
    app.ctx.on('whales/turn-after', (t) => {
      afters.push({ turnId: t.turnId, ok: t.ok, output: t.output })
    })

    await collect(handle.runtime.turn('hey'))
    assert.equal(befores.length, 1)
    assert.equal(afters.length, 1)
    const after = afters[0]
    assert.ok(after)
    assert.equal(after.turnId, befores[0])
    assert.equal(after.ok, true)
    assert.equal(after.output, 'echo: hey')
  })

  test('agent-spawned and agent-disposed fire', async () => {
    const { app } = await makeApp()
    const spawned: AgentId[] = []
    const disposed: AgentId[] = []
    app.ctx.on('whales/agent-spawned', (h) => {
      spawned.push(h.id)
    })
    app.ctx.on('whales/agent-disposed', (id) => {
      disposed.push(id)
    })

    await app.ctx.agents.spawn(baseSpec('ev2'))
    assert.ok(spawned.includes('ev2'))
    await app.ctx.agents.dispose('ev2')
    assert.ok(disposed.includes('ev2'))
  })

  test('app.stop disposes agents and fires agent-disposed', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whales-agents-'))
    const app = await createApp({
      config: defaultConfig({ home, cwd: home }),
      storePath: ':memory:',
    })
    const disposed: AgentId[] = []
    app.ctx.on('whales/agent-disposed', (id) => {
      disposed.push(id)
    })
    await app.ctx.agents.spawn(baseSpec('ev3'))
    await app.stop()
    assert.ok(disposed.includes('ev3'))
    fs.rmSync(home, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// driver errors
// ---------------------------------------------------------------------------

describe('driver errors', () => {
  test('throwing driver yields error then done{error} and agent stays usable', async () => {
    const { app } = await makeApp()
    let calls = 0
    class ThrowDriver extends Service {
      constructor(ctx: Context) {
        super(ctx, 'driver')
      }
      readonly kind = 'throw'
      readonly model = 'throw'
      readonly capabilities = { tools: false, agentic: false, statefulSession: false }
      async *run(_input: TurnInput): AsyncIterable<DriverEvent> {
        calls += 1
        if (calls === 1) {
          throw new Error('kaput')
        }
        yield { type: 'text', delta: 'recovered' }
        yield { type: 'done', stopReason: 'end' }
      }
    }
    app.ctx.agents.catalog.register('driver-throw', ThrowDriver)

    const handle = await app.ctx.agents.spawn(baseSpec('err', { driver: { name: 'driver-throw' } }))
    assert.ok(handle.runtime)

    const events = await collect(handle.runtime.turn('first'))
    const errs = events.filter((e) => e.type === 'error')
    assert.equal(errs.length, 1)
    const err = errs[0]
    assert.ok(err && err.type === 'error')
    assert.ok(err.message.includes('kaput'))
    const dones = events.filter((e) => e.type === 'done')
    assert.equal(dones.length, 1)
    assert.equal(doneOf(events)?.stopReason, 'error')

    const events2 = await collect(handle.runtime.turn('second'))
    assert.equal(doneOf(events2)?.stopReason, 'end')
    assert.equal(textOf(events2), 'recovered')
  })
})
