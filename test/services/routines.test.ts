import { test, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from 'cordis'
import { createApp } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import type { WhalesConfig } from '../../src/contracts/config.ts'
import { Routines, QUIET_SUFFIX } from '../../src/services/routines.ts'
import type { RoutineRun } from '../../src/contracts/routines.ts'
import type { AgentId, PluginRef } from '../../src/contracts/core.ts'
import type { Driver, DriverCapabilities, DriverEvent, TurnInput } from '../../src/contracts/driver.ts'
import type {} from '../../src/contracts/index.ts'

const AGENT_ID = 'agt-aaaaaaaa' as AgentId

interface SpyState {
  prompts: string[]
  script: DriverEvent[]
  delayMs: number
}

const spyState: SpyState = { prompts: [], script: [], delayMs: 0 }

class SpyDriver extends Service implements Driver {
  readonly kind = 'spy'
  readonly model = 'spy'
  readonly capabilities: DriverCapabilities = { tools: false, agentic: false, statefulSession: false }

  constructor(ctx: Context) {
    super(ctx, 'driver')
  }

  async *run(input: TurnInput, signal: AbortSignal): AsyncIterable<DriverEvent> {
    spyState.prompts.push(input.prompt)
    let sawDone = false
    for (const event of spyState.script) {
      if (spyState.delayMs > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, spyState.delayMs)
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t)
              resolve()
            },
            { once: true },
          )
        })
      }
      if (event.type === 'done') {
        sawDone = true
      }
      yield event
    }
    if (!sawDone) {
      yield { type: 'done', stopReason: 'end' }
    }
  }
}

interface Harness {
  app: Awaited<ReturnType<typeof createApp>>
  routines: Routines
  clock: { value: number }
  runs: RoutineRun[]
  dir: string
}

const harnesses: Harness[] = []

beforeEach(() => {
  spyState.prompts = []
  spyState.script = []
  spyState.delayMs = 0
})

async function makeHarness(opts?: { tickMs?: number }): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'whales-rtn-'))
  const clock = { value: Date.parse('2026-10-12T10:00:00Z') }
  const config: WhalesConfig = defaultConfig({ env: {}, home: dir, cwd: dir })
  const app = await createApp({
    config,
    storePath: ':memory:',
    services: { routines: { tickMs: opts?.tickMs ?? 10, now: () => clock.value } },
  })
  app.ctx.agents.catalog.register('driver-spy', SpyDriver)
  const routines = app.ctx.get('routines')
  assert.ok(routines instanceof Routines, 'routines service installed')
  const runs: RoutineRun[] = []
  app.ctx.on('whales/routine-ran', (run) => {
    runs.push(run)
  })
  const h: Harness = { app, routines, clock, runs, dir }
  harnesses.push(h)
  return h
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()
    if (!h) continue
    await h.app.stop()
    await rm(h.dir, { recursive: true, force: true })
  }
})

async function waitFor(pred: () => boolean, description: string, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out waiting for: ${description}`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

function baseInput(overrides?: Partial<Parameters<Routines['add']>[0]>) {
  return {
    agentId: AGENT_ID,
    prompt: 'do the thing',
    everyMinutes: 5,
    quiet: false,
    enabled: true,
    ...overrides,
  }
}

async function spawnAgent(h: Harness, id: AgentId, driver: PluginRef): Promise<void> {
  await h.app.ctx.agents.spawn(
    {
      id,
      name: 'test-agent',
      seniority: 1,
      driver,
      plugins: [],
    },
    { persist: false },
  )
}

// ---------------------------------------------------------------------------
// add validation
// ---------------------------------------------------------------------------

test('add: valid routine shape', async () => {
  const h = await makeHarness()
  const r = h.routines.add(baseInput())
  assert.match(r.id, /^rtn_/)
  assert.equal(r.scope, `agent:${AGENT_ID}`)
  assert.equal(r.agentId, AGENT_ID)
  assert.equal(r.createdAt, h.clock.value)
  assert.equal(r.lastRunAt, undefined)
  assert.equal(r.prompt, 'do the thing')
  assert.equal(r.everyMinutes, 5)
  assert.equal(r.quiet, false)
  assert.equal(r.enabled, true)
})

test('add: agent need not exist', async () => {
  const h = await makeHarness()
  const r = h.routines.add(baseInput({ agentId: 'agt-zzzzzzzz' as AgentId }))
  assert.equal(r.agentId, 'agt-zzzzzzzz')
})

test('add: validation errors', async () => {
  const h = await makeHarness()
  assert.throws(() => h.routines.add(baseInput({ agentId: 'Bad Id' as AgentId })), TypeError)
  assert.throws(() => h.routines.add(baseInput({ prompt: '' })), TypeError)
  assert.throws(() => h.routines.add(baseInput({ prompt: '   ' })), TypeError)
  assert.throws(() => h.routines.add(baseInput({ prompt: 'x'.repeat(4001) })), TypeError)
  assert.throws(() => h.routines.add(baseInput({ everyMinutes: 4 })), TypeError)
  assert.throws(() => h.routines.add(baseInput({ everyMinutes: 10081 })), TypeError)
  assert.throws(() => h.routines.add(baseInput({ everyMinutes: 5.5 })), TypeError)
  assert.throws(
    () => h.routines.add(baseInput({ window: { start: '24:00', end: '23:00' } })),
    TypeError,
  )
  assert.throws(
    () => h.routines.add(baseInput({ window: { start: '9:00', end: '17:00' } })),
    TypeError,
  )
  assert.throws(
    () => h.routines.add(baseInput({ window: { start: '09:00', end: '17:00', days: [] } })),
    TypeError,
  )
  assert.throws(
    () => h.routines.add(baseInput({ window: { start: '09:00', end: '17:00', days: [7] } })),
    TypeError,
  )
  assert.throws(
    () => h.routines.add(baseInput({ window: { start: '09:00', end: '17:00', days: [1, 1] } })),
    TypeError,
  )
  assert.throws(
    () =>
      h.routines.add(
        baseInput({ window: { start: '09:00', end: '17:00', tz: 'Mars/Olympus' } }),
      ),
    TypeError,
  )
  assert.throws(() => h.routines.add(baseInput({ quiet: 'yes' as unknown as boolean })), TypeError)
  assert.throws(() => h.routines.add(baseInput({ enabled: 1 as unknown as boolean })), TypeError)
})

// ---------------------------------------------------------------------------
// update / list / remove
// ---------------------------------------------------------------------------

test('update: patches and validates', async () => {
  const h = await makeHarness()
  const r = h.routines.add(baseInput())
  const updated = h.routines.update(r.id, { prompt: 'new prompt', everyMinutes: 10, quiet: true })
  assert.equal(updated.id, r.id)
  assert.equal(updated.prompt, 'new prompt')
  assert.equal(updated.everyMinutes, 10)
  assert.equal(updated.quiet, true)
  assert.throws(() => h.routines.update(r.id, { everyMinutes: 4 }), TypeError)
  assert.throws(() => h.routines.update(r.id, { prompt: '' }), TypeError)
  assert.throws(() => h.routines.update('rtn_missing', { prompt: 'x' }), /not found/)
})

test('list and remove', async () => {
  const h = await makeHarness()
  const a = h.routines.add(baseInput({ agentId: 'agt-aaaaaaaa' as AgentId }))
  h.clock.value += 1
  const b = h.routines.add(baseInput({ agentId: 'agt-bbbbbbbb' as AgentId }))
  const all = h.routines.list()
  assert.equal(all.length, 2)
  assert.equal(all[0]?.id, a.id)
  assert.equal(all[1]?.id, b.id)
  const onlyA = h.routines.list('agt-aaaaaaaa' as AgentId)
  assert.equal(onlyA.length, 1)
  assert.equal(onlyA[0]?.id, a.id)
  assert.equal(h.routines.remove(a.id), true)
  assert.equal(h.routines.remove(a.id), false)
  assert.equal(h.routines.list().length, 1)
})

// ---------------------------------------------------------------------------
// inWindow
// ---------------------------------------------------------------------------

test('inWindow: undefined window', async () => {
  const h = await makeHarness()
  assert.equal(h.routines.inWindow(undefined, new Date('2026-10-12T10:00:00Z')), true)
})

test('inWindow: simple range UTC', async () => {
  const h = await makeHarness()
  const w = { start: '09:00', end: '17:00', tz: 'UTC' }
  assert.equal(h.routines.inWindow(w, new Date('2026-10-12T10:00:00Z')), true)
  assert.equal(h.routines.inWindow(w, new Date('2026-10-12T17:00:00Z')), false)
  assert.equal(h.routines.inWindow(w, new Date('2026-10-12T08:59:00Z')), false)
})

test('inWindow: wrap midnight', async () => {
  const h = await makeHarness()
  const w = { start: '22:00', end: '06:00', tz: 'UTC' }
  assert.equal(h.routines.inWindow(w, new Date('2026-10-12T23:30:00Z')), true)
  assert.equal(h.routines.inWindow(w, new Date('2026-10-12T05:59:00Z')), true)
  assert.equal(h.routines.inWindow(w, new Date('2026-10-12T12:00:00Z')), false)
})

test('inWindow: start === end is whole day', async () => {
  const h = await makeHarness()
  const w = { start: '09:00', end: '09:00' }
  assert.equal(h.routines.inWindow(w, new Date('2026-10-12T03:00:00Z')), true)
  assert.equal(h.routines.inWindow(w, new Date('2026-10-12T23:00:00Z')), true)
})

test('inWindow: days filter', async () => {
  const h = await makeHarness()
  const w = { start: '00:00', end: '23:59', days: [1], tz: 'UTC' }
  // 2026-10-12 is a Monday.
  assert.equal(h.routines.inWindow(w, new Date('2026-10-12T10:00:00Z')), true)
  assert.equal(h.routines.inWindow(w, new Date('2026-10-13T10:00:00Z')), false)
})

test('inWindow: timezone', async () => {
  const h = await makeHarness()
  const w = { start: '09:00', end: '17:00', tz: 'America/New_York' }
  assert.equal(h.routines.inWindow(w, new Date('2026-10-12T14:00:00Z')), true)
  assert.equal(h.routines.inWindow(w, new Date('2026-10-12T22:00:00Z')), false)
})

// ---------------------------------------------------------------------------
// runNow
// ---------------------------------------------------------------------------

test('runNow: output and prompt (not quiet)', async () => {
  const h = await makeHarness()
  await spawnAgent(h, AGENT_ID, { name: 'driver-stub', config: { template: 'got: {prompt}' } })
  const r = h.routines.add(baseInput({ prompt: 'hello there', quiet: false }))
  const run = await h.routines.runNow(r.id)
  assert.equal(run.routineId, r.id)
  assert.equal(run.agentId, AGENT_ID)
  assert.equal(run.output, 'got: hello there')
  assert.equal(run.silent, false)
  assert.equal(run.error, undefined)
  assert.ok(run.finishedAt >= run.startedAt)
})

test('runNow: quiet appends suffix', async () => {
  const h = await makeHarness()
  await spawnAgent(h, AGENT_ID, { name: 'driver-stub', config: { template: 'got: {prompt}' } })
  const r = h.routines.add(baseInput({ prompt: 'check', quiet: true }))
  const run = await h.routines.runNow(r.id)
  assert.equal(run.output, `got: check${QUIET_SUFFIX}`)
})

test('runNow: quiet NOTHING is silent', async () => {
  const h = await makeHarness()
  spyState.script = [
    { type: 'text', delta: 'NOTHING' },
    { type: 'done', stopReason: 'end' },
  ]
  await spawnAgent(h, AGENT_ID, { name: 'driver-spy' })
  const r = h.routines.add(baseInput({ prompt: 'check', quiet: true }))
  const run = await h.routines.runNow(r.id)
  assert.equal(run.silent, true)
})

test('runNow: quiet real reply not silent', async () => {
  const h = await makeHarness()
  spyState.script = [
    { type: 'text', delta: 'something happened' },
    { type: 'done', stopReason: 'end' },
  ]
  await spawnAgent(h, AGENT_ID, { name: 'driver-spy' })
  const r = h.routines.add(baseInput({ prompt: 'check', quiet: true }))
  const run = await h.routines.runNow(r.id)
  assert.equal(run.silent, false)
})

test('runNow: not quiet NOTHING not silent', async () => {
  const h = await makeHarness()
  spyState.script = [
    { type: 'text', delta: 'NOTHING' },
    { type: 'done', stopReason: 'end' },
  ]
  await spawnAgent(h, AGENT_ID, { name: 'driver-spy' })
  const r = h.routines.add(baseInput({ prompt: 'check', quiet: false }))
  const run = await h.routines.runNow(r.id)
  assert.equal(run.silent, false)
})

test('runNow: emits routine-ran and persists lastRunAt', async () => {
  const h = await makeHarness()
  await spawnAgent(h, AGENT_ID, { name: 'driver-stub', config: { template: 'got: {prompt}' } })
  const r = h.routines.add(baseInput())
  const run = await h.routines.runNow(r.id)
  assert.equal(h.runs.length, 1)
  assert.deepEqual(h.runs[0], run)
  const stored = h.routines.list().find((x) => x.id === r.id)
  assert.ok(stored)
  assert.equal(stored.lastRunAt, run.startedAt)
})

test('runNow: unknown id rejects', async () => {
  const h = await makeHarness()
  await assert.rejects(() => h.routines.runNow('rtn_missing'), /not found/)
})

test('runNow: agent not spawned rejects mentioning agent id', async () => {
  const h = await makeHarness()
  const r = h.routines.add(baseInput())
  await assert.rejects(
    () => h.routines.runNow(r.id),
    (err: Error) => {
      assert.ok(err.message.includes(AGENT_ID))
      return true
    },
  )
})

test('runNow: driver error surfaces', async () => {
  const h = await makeHarness()
  spyState.script = [
    { type: 'error', message: 'boom' },
    { type: 'done', stopReason: 'error' },
  ]
  await spawnAgent(h, AGENT_ID, { name: 'driver-spy' })
  const r = h.routines.add(baseInput({ quiet: true }))
  const run = await h.routines.runNow(r.id)
  assert.ok(run.error)
  assert.ok(run.error.includes('boom'))
  assert.equal(run.silent, false)
})

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------

test('scheduler: due timing', async () => {
  const h = await makeHarness()
  await spawnAgent(h, AGENT_ID, { name: 'driver-stub', config: { template: 'got: {prompt}' } })
  const r = h.routines.add(baseInput({ everyMinutes: 5 }))
  const t = h.clock.value
  await new Promise((res) => setTimeout(res, 50))
  assert.equal(h.runs.length, 0, 'not due before interval')
  h.clock.value = t + 5 * 60_000
  await waitFor(() => h.runs.length === 1, 'first scheduled run')
  await new Promise((res) => setTimeout(res, 60))
  assert.equal(h.runs.length, 1, 'no second run without clock advance')
  h.clock.value = t + 10 * 60_000
  await waitFor(() => h.runs.length === 2, 'second scheduled run')
  assert.equal(h.runs[0]?.routineId, r.id)
})

test('scheduler: disabled routines never run', async () => {
  const h = await makeHarness()
  await spawnAgent(h, AGENT_ID, { name: 'driver-stub', config: { template: 'got: {prompt}' } })
  h.routines.add(baseInput({ enabled: false }))
  h.clock.value += 10 * 60_000
  await new Promise((res) => setTimeout(res, 60))
  assert.equal(h.runs.length, 0)
})

test('scheduler: unspawned agent skipped', async () => {
  const h = await makeHarness()
  h.routines.add(baseInput({ agentId: 'agt-zzzzzzzz' as AgentId }))
  h.clock.value += 10 * 60_000
  await new Promise((res) => setTimeout(res, 60))
  assert.equal(h.runs.length, 0)
})

test('scheduler: outside window skipped', async () => {
  const h = await makeHarness()
  await spawnAgent(h, AGENT_ID, { name: 'driver-stub', config: { template: 'got: {prompt}' } })
  h.routines.add(baseInput({ window: { start: '00:00', end: '01:00', tz: 'UTC' } }))
  h.clock.value += 10 * 60_000
  await new Promise((res) => setTimeout(res, 60))
  assert.equal(h.runs.length, 0)
})

test('scheduler: busy agent skipped', async () => {
  const h = await makeHarness()
  await spawnAgent(h, AGENT_ID, {
    name: 'driver-stub',
    config: { template: 'got: {prompt}', delayMs: 30 },
  })
  const handle = h.app.ctx.agents.get(AGENT_ID)
  assert.ok(handle)
  const runtime = handle.runtime
  assert.ok(runtime)
  const background = (async () => {
    for await (const _ of runtime.turn('manual long turn')) {
      void _
    }
  })()
  h.routines.add(baseInput({ everyMinutes: 5 }))
  h.clock.value += 10 * 60_000
  await new Promise((res) => setTimeout(res, 60))
  assert.equal(h.runs.length, 0, 'busy agent skipped')
  await background
})

// ---------------------------------------------------------------------------
// no overlap
// ---------------------------------------------------------------------------

test('no overlap: single in-flight run', async () => {
  const h = await makeHarness()
  spyState.delayMs = 40
  spyState.script = [
    { type: 'text', delta: 'slow reply here' },
    { type: 'text', delta: ' more' },
    { type: 'done', stopReason: 'end' },
  ]
  await spawnAgent(h, AGENT_ID, { name: 'driver-spy' })
  const r = h.routines.add(baseInput({ everyMinutes: 5 }))
  const t = h.clock.value
  h.clock.value = t + 5 * 60_000
  await waitFor(() => spyState.prompts.length === 1, 'first run prompt recorded')
  for (let i = 0; i < 2; i++) {
    h.clock.value += 60 * 60_000
    await new Promise((res) => setTimeout(res, 20))
  }
  assert.equal(spyState.prompts.length, 1, 'no overlapping runs')
  await assert.rejects(() => h.routines.runNow(r.id), /already running/)
  await waitFor(() => h.runs.length === 1, 'first run finished')
})

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

test('dispose: no runs after stop', async () => {
  const h = await makeHarness()
  await spawnAgent(h, AGENT_ID, { name: 'driver-stub', config: { template: 'got: {prompt}' } })
  h.routines.add(baseInput())
  const before = h.runs.length
  await h.app.stop()
  h.clock.value += 10 * 60_000
  await new Promise((res) => setTimeout(res, 50))
  assert.equal(h.runs.length, before)
})
