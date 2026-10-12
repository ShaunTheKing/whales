import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from 'cordis'
import { createApp } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import type { WhalesConfig } from '../../src/contracts/config.ts'
import { Memory, tokenize } from '../../src/services/memory.ts'
import type { MemoryService } from '../../src/contracts/memory.ts'
import type { TurnInput } from '../../src/contracts/driver.ts'
import type {} from '../../src/contracts/agents.ts'
import type {} from '../../src/contracts/tools.ts'
import type {} from '../../src/contracts/store.ts'

const inputs: TurnInput[] = []

class SpyDriver extends Service {
  kind = 'spy'
  model = 'spy'
  capabilities = { tools: false, agentic: false, statefulSession: false }
  constructor(ctx: Context) {
    super(ctx, 'driver')
  }
  async *run(input: TurnInput) {
    inputs.push(input)
    yield { type: 'text', delta: 'ok' } as const
    yield { type: 'done', stopReason: 'end' } as const
  }
}

interface Harness {
  app: Awaited<ReturnType<typeof createApp>>
  dir: string
}

const harnesses: Harness[] = []

async function makeApp(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'whales-mem-'))
  const config: WhalesConfig = defaultConfig({ env: {}, home: dir, cwd: dir })
  const app = await createApp({ config, storePath: ':memory:' })
  const h: Harness = { app, dir }
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
  inputs.length = 0
})

function memoryOf(handle: { ctx: Context }): MemoryService {
  const m = handle.ctx.get('memory')
  assert.ok(m instanceof Memory)
  return m
}

test('tokenize lower-cases, splits, drops stopwords and short tokens, keeps unicode', () => {
  assert.deepEqual(tokenize('Café 2024 prix'), ['café', '2024', 'prix'])
  assert.deepEqual(tokenize('The Quick, brown FOX!'), ['quick', 'brown', 'fox'])
  assert.deepEqual(tokenize('a an and or of to in on at for with is are'), [])
  assert.deepEqual(tokenize('I me my we our they them their he she his her'), [])
  assert.deepEqual(tokenize('x y z ab'), ['ab'])
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize('   ...   '), [])
})

test('remember trims, stores scope/tags/source, rejects invalid input', async () => {
  const { app } = await makeApp()
  const handle = await app.ctx.agents.spawn(
    {
      id: 'a1',
      name: 'A1',
      seniority: 1,
      driver: { name: 'driver-stub', config: { template: '{prompt}' } },
      plugins: [{ name: 'memory' }],
    },
    { persist: false },
  )
  const memory = memoryOf(handle)

  const note = memory.remember('  hello world  ', {
    tags: ['Work', 'work', 'BILLING'],
    source: { roomId: 'r1' },
  })
  assert.equal(note.text, 'hello world')
  assert.equal(note.scope, 'agent:a1')
  assert.deepEqual(note.tags, ['work', 'billing'])
  assert.deepEqual(note.source, { roomId: 'r1' })
  assert.ok(note.id.startsWith('mem_'))
  assert.equal(typeof note.createdAt, 'number')

  const stored = app.ctx.store.collection('memories').get(note.id)
  assert.ok(stored)
  assert.equal(stored.text, 'hello world')
  assert.equal(stored.scope, 'agent:a1')

  assert.throws(() => memory.remember(''), TypeError)
  assert.throws(() => memory.remember('   '), TypeError)
  assert.throws(() => memory.remember('x'.repeat(2001)), TypeError)
  assert.throws(() => memory.remember('ok', { tags: ['no spaces'] }), TypeError)
  assert.throws(
    () => memory.remember('ok', { tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'] }),
    TypeError,
  )
})

test('recall ranks relevant notes first with scores in (0,1) descending', async () => {
  const { app } = await makeApp()
  const handle = await app.ctx.agents.spawn(
    {
      id: 'a1',
      name: 'A1',
      seniority: 1,
      driver: { name: 'driver-stub', config: { template: '{prompt}' } },
      plugins: [{ name: 'memory' }],
    },
    { persist: false },
  )
  const memory = memoryOf(handle)

  memory.remember('postgres database migrations are run with pnpm migrate')
  memory.remember('my favourite colour is blue')
  memory.remember('deploy on fridays is forbidden')

  const results = memory.recall('which database do we use')
  assert.ok(results.length > 0)
  assert.ok(results[0]?.note.text.includes('postgres'))

  for (const r of results) {
    assert.ok(r.score > 0)
    assert.ok(r.score < 1)
  }
  for (let i = 1; i < results.length; i += 1) {
    const prev = results[i - 1]
    const cur = results[i]
    assert.ok(prev && cur)
    assert.ok(prev.score >= cur.score)
  }

  const none = memory.recall('zzzzz qqqqq')
  assert.deepEqual(none, [])
})

test('recall respects limit, validates limit, handles stopword-only queries', async () => {
  const { app } = await makeApp()
  const handle = await app.ctx.agents.spawn(
    {
      id: 'a1',
      name: 'A1',
      seniority: 1,
      driver: { name: 'driver-stub', config: { template: '{prompt}' } },
      plugins: [{ name: 'memory' }],
    },
    { persist: false },
  )
  const memory = memoryOf(handle)

  memory.remember('alpha database thing')
  memory.remember('beta database thing')
  memory.remember('gamma database thing')

  const limited = memory.recall('database', 2)
  assert.equal(limited.length, 2)

  assert.throws(() => memory.recall('database', 0), RangeError)
  assert.throws(() => memory.recall('database', 51), RangeError)

  assert.deepEqual(memory.recall('the and of to'), [])
})

test('recall matches tags and sets lastUsedAt on returned notes', async () => {
  const { app } = await makeApp()
  const handle = await app.ctx.agents.spawn(
    {
      id: 'a1',
      name: 'A1',
      seniority: 1,
      driver: { name: 'driver-stub', config: { template: '{prompt}' } },
      plugins: [{ name: 'memory' }],
    },
    { persist: false },
  )
  const memory = memoryOf(handle)

  const tagged = memory.remember('quarterly invoice summary', { tags: ['billing'] })
  memory.remember('unrelated note about cats')

  const results = memory.recall('billing')
  assert.ok(results.length > 0)
  assert.equal(results[0]?.note.id, tagged.id)

  // recall() above already stamped lastUsedAt on the returned note.
  const before = app.ctx.store.collection('memories').get(tagged.id)
  assert.ok(before)
  assert.equal(typeof before.lastUsedAt, 'number')

  const again = memory.recall('billing')
  assert.ok(again.length > 0)
  const after = app.ctx.store.collection('memories').get(tagged.id)
  assert.ok(after)
  assert.equal(typeof after.lastUsedAt, 'number')
})

test('recall default limit comes from config recallLimit', async () => {
  const { app } = await makeApp()
  const handle = await app.ctx.agents.spawn(
    {
      id: 'a1',
      name: 'A1',
      seniority: 1,
      driver: { name: 'driver-stub', config: { template: '{prompt}' } },
      plugins: [{ name: 'memory', config: { recallLimit: 2 } }],
    },
    { persist: false },
  )
  const memory = memoryOf(handle)

  memory.remember('database one')
  memory.remember('database two')
  memory.remember('database three')

  const results = memory.recall('database')
  assert.equal(results.length, 2)
})

test('memory is isolated per agent and forget is scoped', async () => {
  const { app } = await makeApp()
  const a = await app.ctx.agents.spawn(
    {
      id: 'a1',
      name: 'A1',
      seniority: 1,
      driver: { name: 'driver-stub', config: { template: '{prompt}' } },
      plugins: [{ name: 'memory' }],
    },
    { persist: false },
  )
  const b = await app.ctx.agents.spawn(
    {
      id: 'b1',
      name: 'B1',
      seniority: 1,
      driver: { name: 'driver-stub', config: { template: '{prompt}' } },
      plugins: [{ name: 'memory' }],
    },
    { persist: false },
  )
  const memA = memoryOf(a)
  const memB = memoryOf(b)

  const noteA = memA.remember('secret database password rotation')
  memB.remember('something else entirely')

  assert.equal(memB.list().length, 1)
  assert.ok(!memB.list().some((n) => n.id === noteA.id))
  assert.ok(!memB.recall('database password').some((r) => r.note.id === noteA.id))

  assert.equal(memB.forget(noteA.id), false)
  assert.ok(memA.list().some((n) => n.id === noteA.id))
})

test('list is ascending by createdAt and forget removes own notes', async () => {
  const { app } = await makeApp()
  const handle = await app.ctx.agents.spawn(
    {
      id: 'a1',
      name: 'A1',
      seniority: 1,
      driver: { name: 'driver-stub', config: { template: '{prompt}' } },
      plugins: [{ name: 'memory' }],
    },
    { persist: false },
  )
  const memory = memoryOf(handle)

  const first = memory.remember('first note')
  const second = memory.remember('second note')
  const third = memory.remember('third note')

  const listed = memory.list()
  assert.deepEqual(
    listed.map((n) => n.id),
    [first.id, second.id, third.id],
  )
  for (let i = 1; i < listed.length; i += 1) {
    const prev = listed[i - 1]
    const cur = listed[i]
    assert.ok(prev && cur)
    assert.ok(prev.createdAt <= cur.createdAt)
  }

  assert.equal(memory.forget(second.id), true)
  assert.equal(memory.forget(second.id), false)
  assert.deepEqual(
    memory.list().map((n) => n.id),
    [first.id, third.id],
  )
})

test('notes follow the agent across dispose and respawn with the same id', async () => {
  const { app } = await makeApp()
  const spec = {
    id: 'a1',
    name: 'A1',
    seniority: 1,
    driver: { name: 'driver-stub', config: { template: '{prompt}' } },
    plugins: [{ name: 'memory' }],
  }
  const first = await app.ctx.agents.spawn(spec, { persist: false })
  const memFirst = memoryOf(first)
  const note = memFirst.remember('persistent memory note about databases')

  await app.ctx.agents.dispose('a1')

  const second = await app.ctx.agents.spawn(spec, { persist: false })
  const memSecond = memoryOf(second)
  const listed = memSecond.list()
  assert.ok(listed.some((n) => n.id === note.id))
  assert.ok(memSecond.recall('databases').some((r) => r.note.id === note.id))
})

test('prompt section injects recalled notes into the system prompt', async () => {
  const { app } = await makeApp()
  app.ctx.agents.catalog.register('spy-driver', SpyDriver)
  const handle = await app.ctx.agents.spawn(
    {
      id: 'a1',
      name: 'A1',
      seniority: 1,
      driver: { name: 'spy-driver', config: {} },
      plugins: [{ name: 'memory' }],
    },
    { persist: false },
  )
  const memory = memoryOf(handle)
  memory.remember('The deploy password rotation happens on Mondays')

  const runtime = handle.runtime
  assert.ok(runtime)

  for await (const _event of runtime.turn('when does password rotation happen')) {
    void _event
  }
  const relevant = inputs.at(-1)
  assert.ok(relevant)
  assert.ok(relevant.system.includes('Relevant notes from your memory:'))
  assert.ok(relevant.system.includes('The deploy password rotation happens on Mondays'))

  for await (const _event of runtime.turn('hello there')) {
    void _event
  }
  const unrelated = inputs.at(-1)
  assert.ok(unrelated)
  assert.ok(!unrelated.system.includes('Relevant notes from your memory:'))
})

test('remember tool is registered, side-effect free, and validates input', async () => {
  const { app } = await makeApp()
  const handle = await app.ctx.agents.spawn(
    {
      id: 'a1',
      name: 'A1',
      seniority: 1,
      driver: { name: 'driver-stub', config: { template: '{prompt}' } },
      plugins: [{ name: 'memory' }],
    },
    { persist: false },
  )
  const tools = handle.ctx.get('tools')
  assert.ok(tools)

  const spec = tools.list().find((s) => s.name === 'remember')
  assert.ok(spec)
  assert.deepEqual(spec.inputSchema.required, ['text'])

  const set = tools.forTurn({})
  const signal = new AbortController().signal

  const ok = await set.invoke({ id: 'c1', name: 'remember', input: { text: 'a saved note' } }, signal)
  assert.equal(ok.isError, false)
  assert.ok(ok.output.startsWith('Saved note mem_'))

  const bad = await set.invoke({ id: 'c2', name: 'remember', input: { text: 5 } }, signal)
  assert.equal(bad.isError, true)

  const empty = await set.invoke({ id: 'c3', name: 'remember', input: { text: '' } }, signal)
  assert.equal(empty.isError, true)
})

test('invalid config recallLimit 0 rejects spawn', async () => {
  const { app } = await makeApp()
  await assert.rejects(
    Promise.resolve(
      app.ctx.agents.spawn(
        {
          id: 'a1',
          name: 'A1',
          seniority: 1,
          driver: { name: 'driver-stub', config: { template: '{prompt}' } },
          plugins: [{ name: 'memory', config: { recallLimit: 0 } }],
        },
        { persist: false },
      ),
    ),
  )
})

test('disposing the agent removes its memory service', async () => {
  const { app } = await makeApp()
  const handle = await app.ctx.agents.spawn(
    {
      id: 'a1',
      name: 'A1',
      seniority: 1,
      driver: { name: 'driver-stub', config: { template: '{prompt}' } },
      plugins: [{ name: 'memory' }],
    },
    { persist: false },
  )
  assert.ok(handle.ctx.get('memory') instanceof Memory)

  await app.ctx.agents.dispose('a1')
  assert.equal(handle.ctx.get('memory'), undefined)
})
