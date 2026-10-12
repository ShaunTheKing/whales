import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from 'cordis'
import { createApp } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import { Rooms, ARBITER_INSTRUCTION, parseTeamJson } from '../../src/services/rooms.ts'
import type { Driver, DriverCapabilities, DriverEvent, TurnInput } from '../../src/contracts/driver.ts'
import type { AgentId } from '../../src/contracts/core.ts'
import type {} from '../../src/contracts/rooms.ts'
import type {} from '../../src/contracts/agents.ts'
import type {} from '../../src/contracts/approvals.ts'
import type {} from '../../src/contracts/config.ts'

interface SpyRecord {
  agentName: string
  start: number
  end: number
  input: TurnInput
}

const spyLog: SpyRecord[] = []

class SpyDriver extends Service implements Driver {
  readonly kind = 'spy'
  readonly model = 'spy'
  readonly capabilities: DriverCapabilities = { tools: false, agentic: false, statefulSession: false }
  reply: string
  delayMs: number
  agentName: string

  constructor(ctx: Context, config: { reply: string; delayMs?: number; agentName?: string }) {
    super(ctx, 'driver')
    this.reply = config.reply
    this.delayMs = config.delayMs ?? 0
    this.agentName = config.agentName ?? 'spy'
  }

  async *run(input: TurnInput, signal: AbortSignal): AsyncIterable<DriverEvent> {
    const start = Date.now()
    const record: SpyRecord = { agentName: this.agentName, start, end: start, input }
    spyLog.push(record)
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs))
    }
    if (signal.aborted) {
      record.end = Date.now()
      yield { type: 'done', stopReason: 'cancelled' }
      return
    }
    if (this.reply.length > 0) {
      yield { type: 'text', delta: this.reply }
    }
    record.end = Date.now()
    yield { type: 'done', stopReason: 'end' }
  }
}

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'whales-rooms-'))
}

interface Harness {
  app: Awaited<ReturnType<typeof createApp>>
  rooms: Rooms
  tmp: string
}

async function setup(opts?: {
  historyLimit?: number
  cheapDriver?: { name: string; config?: Record<string, unknown> }
}): Promise<Harness> {
  const tmp = await makeTmp()
  const config = defaultConfig({ env: {}, home: tmp, cwd: tmp })
  if (opts?.cheapDriver) {
    config.defaults.cheapDriver = opts.cheapDriver
  }
  const app = await createApp({
    config,
    storePath: ':memory:',
    services: { rooms: opts?.historyLimit !== undefined ? { historyLimit: opts.historyLimit } : {} },
  })
  app.ctx.agents.catalog.register('driver-spy', SpyDriver)
  const rooms = app.ctx.get('rooms')
  assert.ok(rooms instanceof Rooms, 'rooms service installed')
  return { app, rooms, tmp }
}

async function teardown(h: Harness): Promise<void> {
  await h.app.stop()
  await rm(h.tmp, { recursive: true, force: true })
}

function spySpec(id: string, name: string, seniority: number, reply: string, delayMs?: number) {
  return {
    id,
    name,
    seniority,
    driver: { name: 'driver-spy', config: { reply, delayMs, agentName: name } },
    plugins: [],
  }
}

async function spawnSpy(
  h: Harness,
  id: string,
  name: string,
  seniority: number,
  reply: string,
  delayMs?: number,
): Promise<void> {
  await h.app.ctx.agents.spawn(spySpec(id, name, seniority, reply, delayMs), { persist: false })
}

async function collect(iter: AsyncIterable<import('../../src/contracts/rooms.ts').RoomEvent>) {
  const events: import('../../src/contracts/rooms.ts').RoomEvent[] = []
  for await (const ev of iter) events.push(ev)
  return events
}

test('create validation', async () => {
  const h = await setup()
  try {
    await spawnSpy(h, 'ann', 'Ann', 1, 'hi')
    assert.throws(() => h.rooms.create({ name: '', members: ['ann'] }), TypeError)
    assert.throws(() => h.rooms.create({ name: 'x'.repeat(65), members: ['ann'] }), TypeError)
    assert.throws(() => h.rooms.create({ name: 'ok', members: [] }), TypeError)
    assert.throws(() => h.rooms.create({ name: 'ok', members: ['ann', 'ann'] }), TypeError)
    assert.throws(() => h.rooms.create({ name: 'ok', members: ['BAD ID'] }), TypeError)
    assert.throws(() => h.rooms.create({ name: 'ok', members: ['ghost'] }), /ghost/)
    const room = h.rooms.create({ name: '  Team  ', members: ['ann'] })
    assert.equal(room.name, 'Team')
    assert.ok(room.id.startsWith('room_'))
    assert.deepEqual(room.members, ['ann'])
  } finally {
    await teardown(h)
  }
})

test('stored-but-not-running agent is accepted', async () => {
  const h = await setup()
  try {
    await h.app.ctx.store.collection('agents').put({
      id: 'stored',
      scope: 'global',
      createdAt: Date.now(),
      spec: {
        id: 'stored',
        name: 'Stored',
        seniority: 1,
        driver: { name: 'driver-stub', config: {} },
        plugins: [],
      },
    })
    const room = h.rooms.create({ name: 'r', members: ['stored'] })
    assert.deepEqual(room.members, ['stored'])
  } finally {
    await teardown(h)
  }
})

test('get/list/delete clears messages and notes', async () => {
  const h = await setup()
  try {
    await spawnSpy(h, 'ann', 'Ann', 1, 'hi')
    const room = h.rooms.create({ name: 'r', members: ['ann'] })
    assert.equal(h.rooms.get(room.id)?.id, room.id)
    assert.equal(h.rooms.list().length, 1)
    h.rooms.addNote(room.id, 'user', 'note one')
    assert.equal(h.rooms.notes(room.id).length, 1)
    assert.equal(h.rooms.delete(room.id), true)
    assert.equal(h.rooms.get(room.id), undefined)
    assert.equal(h.rooms.notes(room.id).length, 0)
    assert.equal(h.rooms.history(room.id).length, 0)
    assert.equal(h.rooms.delete(room.id), false)
  } finally {
    await teardown(h)
  }
})

test('addMember/removeMember rules', async () => {
  const h = await setup()
  try {
    await spawnSpy(h, 'ann', 'Ann', 1, 'hi')
    await spawnSpy(h, 'bob', 'Bob', 2, 'hi')
    const room = h.rooms.create({ name: 'r', members: ['ann'] })
    assert.throws(() => h.rooms.addMember(room.id, 'ann'), /already|duplicate/i)
    const updated = h.rooms.addMember(room.id, 'bob')
    assert.deepEqual(updated.members, ['ann', 'bob'])
    assert.throws(() => h.rooms.removeMember(room.id, 'ghost'), /member|not/i)
    h.rooms.removeMember(room.id, 'bob')
    assert.throws(() => h.rooms.removeMember(room.id, 'ann'), /last/i)
    assert.throws(() => h.rooms.addMember('room_missing', 'ann'), /not found/)
    assert.throws(() => h.rooms.removeMember('room_missing', 'ann'), /not found/)
    assert.throws(() => h.rooms.order('room_missing'), /not found/)
  } finally {
    await teardown(h)
  }
})

test('order ascending seniority, ties keep member order', async () => {
  const h = await setup()
  try {
    await spawnSpy(h, 'a5', 'A5', 5, 'x')
    await spawnSpy(h, 'b1', 'B1', 1, 'x')
    await spawnSpy(h, 'c3', 'C3', 3, 'x')
    const room = h.rooms.create({ name: 'r', members: ['a5', 'b1', 'c3'] })
    assert.deepEqual(h.rooms.order(room.id), ['b1', 'c3', 'a5'])

    await spawnSpy(h, 'd2', 'D2', 2, 'x')
    await spawnSpy(h, 'e2', 'E2', 2, 'x')
    const room2 = h.rooms.create({ name: 'r2', members: ['d2', 'e2'] })
    assert.deepEqual(h.rooms.order(room2.id), ['d2', 'e2'])
  } finally {
    await teardown(h)
  }
})

test('ACCEPTANCE: no overlap, senior last, arbitration', async () => {
  const h = await setup()
  try {
    spyLog.length = 0
    await spawnSpy(h, 'ann', 'Ann', 1, 'Use tabs.', 15)
    await spawnSpy(h, 'bob', 'Bob', 2, 'No, use spaces.', 15)
    await spawnSpy(h, 'cy', 'Cy', 10, 'Decision: spaces. Bob is right; tabs lose.', 15)
    const room = h.rooms.create({ name: 'Style', members: ['cy', 'ann', 'bob'] })

    const events = await collect(h.rooms.post(room.id, 'Tabs or spaces?'))

    const roundStart = events.find((e) => e.type === 'round-start')
    assert.ok(roundStart && roundStart.type === 'round-start')
    assert.deepEqual(roundStart.order, ['ann', 'bob', 'cy'])

    const speakers = events.filter((e) => e.type === 'speaker')
    assert.deepEqual(
      speakers.map((e) => (e.type === 'speaker' ? e.agentId : '')),
      ['ann', 'bob', 'cy'],
    )
    for (const s of speakers) {
      if (s.type !== 'speaker') continue
      assert.equal(s.arbiter, s.agentId === 'cy')
    }

    // agent events occur after their speaker event and before the next speaker event
    const speakerIndex = new Map<string, number>()
    events.forEach((e, i) => {
      if (e.type === 'speaker') speakerIndex.set(e.agentId, i)
    })
    const speakerOrder = ['ann', 'bob', 'cy']
    events.forEach((e, i) => {
      if (e.type !== 'agent') return
      const own = speakerIndex.get(e.agentId)
      assert.ok(own !== undefined && i > own, 'agent event after speaker')
      const pos = speakerOrder.indexOf(e.agentId)
      const next = speakerOrder[pos + 1]
      if (next !== undefined) {
        const nextIdx = speakerIndex.get(next)
        assert.ok(nextIdx !== undefined && i < nextIdx, 'agent event before next speaker')
      }
    })

    // no overlap in spy intervals
    const sorted = [...spyLog].sort((a, b) => a.start - b.start)
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]
      const cur = sorted[i]
      assert.ok(prev && cur)
      assert.ok(cur.start >= prev.end, `overlap between ${prev.agentName} and ${cur.agentName}`)
    }

    const messages = events.filter((e) => e.type === 'message')
    assert.deepEqual(
      messages.map((e) => (e.type === 'message' ? e.message.speaker : '')),
      ['ann', 'bob', 'cy'],
    )
    for (const m of messages) {
      if (m.type !== 'message') continue
      assert.equal(m.message.round, 1)
    }
    const last = messages.at(-1)
    assert.ok(last && last.type === 'message' && last.message.content.includes('Decision'))

    const cyRecord = spyLog.find((r) => r.agentName === 'Cy')
    const annRecord = spyLog.find((r) => r.agentName === 'Ann')
    const bobRecord = spyLog.find((r) => r.agentName === 'Bob')
    assert.ok(cyRecord && annRecord && bobRecord)
    assert.ok(cyRecord.input.prompt.includes(ARBITER_INSTRUCTION))
    assert.ok(!annRecord.input.prompt.includes(ARBITER_INSTRUCTION))
    assert.ok(!bobRecord.input.prompt.includes(ARBITER_INSTRUCTION))

    const cyHistory = cyRecord.input.history
    const annInCy = cyHistory.find((m) => m.name === 'Ann')
    const bobInCy = cyHistory.find((m) => m.name === 'Bob')
    assert.ok(annInCy && annInCy.role === 'user' && annInCy.content.includes('tabs'))
    assert.ok(bobInCy && bobInCy.role === 'user' && bobInCy.content.includes('spaces'))
    const userInCy = cyHistory.find((m) => m.name === 'user')
    assert.ok(userInCy && userInCy.content.includes('Tabs or spaces?'))

    const bobHistory = bobRecord.input.history
    assert.ok(bobHistory.some((m) => m.name === 'Ann'))
    assert.ok(!bobHistory.some((m) => m.name === 'Cy'))
  } finally {
    await teardown(h)
  }
})

test('prompt contains room name, member list, identity, latest message; notes appear', async () => {
  const h = await setup()
  try {
    spyLog.length = 0
    await spawnSpy(h, 'ann', 'Ann', 1, 'a')
    await spawnSpy(h, 'bob', 'Bob', 2, 'b')
    const room = h.rooms.create({ name: 'Kitchen', members: ['ann', 'bob'] })
    h.rooms.addNote(room.id, 'user', 'remember the milk')
    await collect(h.rooms.post(room.id, 'What is up?'))

    for (const rec of spyLog) {
      assert.ok(rec.input.prompt.includes('Kitchen'))
      assert.ok(rec.input.prompt.includes('Ann, Bob'))
      assert.ok(rec.input.prompt.includes(`You are ${rec.agentName}`))
      assert.ok(rec.input.prompt.includes('Latest message from the user:'))
      assert.ok(rec.input.prompt.includes('What is up?'))
      assert.ok(rec.input.prompt.includes('Shared room notes:'))
      assert.ok(rec.input.prompt.includes('remember the milk'))
    }
  } finally {
    await teardown(h)
  }
})

test('second post is round 2 and each agent sees own earlier reply as assistant', async () => {
  const h = await setup()
  try {
    spyLog.length = 0
    await spawnSpy(h, 'ann', 'Ann', 1, 'ann-reply')
    await spawnSpy(h, 'bob', 'Bob', 2, 'bob-reply')
    const room = h.rooms.create({ name: 'r', members: ['ann', 'bob'] })
    await collect(h.rooms.post(room.id, 'first'))
    spyLog.length = 0
    const events = await collect(h.rooms.post(room.id, 'second'))
    const roundStart = events.find((e) => e.type === 'round-start')
    assert.ok(roundStart && roundStart.type === 'round-start')
    assert.equal(roundStart.round, 2)

    const annRecord = spyLog.find((r) => r.agentName === 'Ann')
    assert.ok(annRecord)
    const own = annRecord.input.history.find((m) => m.role === 'assistant')
    assert.ok(own && own.content.includes('ann-reply'))
  } finally {
    await teardown(h)
  }
})

test('concurrent posts in same room are serialised', async () => {
  const h = await setup()
  try {
    spyLog.length = 0
    await spawnSpy(h, 'ann', 'Ann', 1, 'a', 10)
    await spawnSpy(h, 'bob', 'Bob', 2, 'b', 10)
    const room = h.rooms.create({ name: 'r', members: ['ann', 'bob'] })

    const first: import('../../src/contracts/rooms.ts').RoomEvent[] = []
    const second: import('../../src/contracts/rooms.ts').RoomEvent[] = []
    const p1 = (async () => {
      for await (const ev of h.rooms.post(room.id, 'one')) first.push(ev)
    })()
    const p2 = (async () => {
      for await (const ev of h.rooms.post(room.id, 'two')) second.push(ev)
    })()
    await Promise.all([p1, p2])

    const firstEnd = first.findIndex((e) => e.type === 'round-end')
    const secondStart = second.findIndex((e) => e.type === 'round-start')
    assert.ok(firstEnd >= 0 && secondStart >= 0)
    // whichever ran first, its round-end precedes the other's round-start in wall-clock order
    const firstRound = first.find((e) => e.type === 'round-start')
    const secondRound = second.find((e) => e.type === 'round-start')
    assert.ok(firstRound && secondRound)
    const firstNum = firstRound.type === 'round-start' ? firstRound.round : 0
    const secondNum = secondRound.type === 'round-start' ? secondRound.round : 0
    assert.deepEqual([firstNum, secondNum].sort(), [1, 2])
  } finally {
    await teardown(h)
  }
})

test('two different rooms both complete', async () => {
  const h = await setup()
  try {
    await spawnSpy(h, 'ann', 'Ann', 1, 'a', 5)
    const r1 = h.rooms.create({ name: 'r1', members: ['ann'] })
    const r2 = h.rooms.create({ name: 'r2', members: ['ann'] })
    const [e1, e2] = await Promise.all([collect(h.rooms.post(r1.id, 'x')), collect(h.rooms.post(r2.id, 'y'))])
    assert.ok(e1.some((e) => e.type === 'round-end'))
    assert.ok(e2.some((e) => e.type === 'round-end'))
  } finally {
    await teardown(h)
  }
})

test('stored-but-not-running member is skipped', async () => {
  const h = await setup()
  try {
    await spawnSpy(h, 'ann', 'Ann', 1, 'a')
    await h.app.ctx.store.collection('agents').put({
      id: 'ghost',
      scope: 'global',
      createdAt: Date.now(),
      spec: {
        id: 'ghost',
        name: 'Ghost',
        seniority: 5,
        driver: { name: 'driver-stub', config: {} },
        plugins: [],
      },
    })
    const room = h.rooms.create({ name: 'r', members: ['ann', 'ghost'] })
    const events = await collect(h.rooms.post(room.id, 'hi'))
    const skipped = events.find((e) => e.type === 'skipped')
    assert.ok(skipped && skipped.type === 'skipped')
    assert.equal(skipped.agentId, 'ghost')
    assert.equal(skipped.reason, 'agent is not running')
    assert.ok(events.some((e) => e.type === 'round-end'))
  } finally {
    await teardown(h)
  }
})

test('empty turn text is skipped', async () => {
  const h = await setup()
  try {
    await spawnSpy(h, 'ann', 'Ann', 1, '')
    const room = h.rooms.create({ name: 'r', members: ['ann'] })
    const events = await collect(h.rooms.post(room.id, 'hi'))
    const skipped = events.find((e) => e.type === 'skipped')
    assert.ok(skipped && skipped.type === 'skipped')
    assert.equal(skipped.agentId, 'ann')
    assert.ok(!events.some((e) => e.type === 'message'))
  } finally {
    await teardown(h)
  }
})

test('agent DM history untouched', async () => {
  const h = await setup()
  try {
    await spawnSpy(h, 'ann', 'Ann', 1, 'a')
    const room = h.rooms.create({ name: 'r', members: ['ann'] })
    await collect(h.rooms.post(room.id, 'hi'))
    const count = await h.app.ctx.store.collection('messages').count({ scope: 'agent:ann' })
    assert.equal(count, 0)
  } finally {
    await teardown(h)
  }
})

test('whales/room-event emitted for every yielded event', async () => {
  const h = await setup()
  try {
    await spawnSpy(h, 'ann', 'Ann', 1, 'a')
    const room = h.rooms.create({ name: 'r', members: ['ann'] })
    const emitted: import('../../src/contracts/rooms.ts').RoomEvent[] = []
    h.app.ctx.on('whales/room-event', (_id: string, ev: import('../../src/contracts/rooms.ts').RoomEvent) => {
      emitted.push(ev)
    })
    const events = await collect(h.rooms.post(room.id, 'hi'))
    assert.equal(emitted.length, events.length)
    assert.deepEqual(
      emitted.map((e) => e.type),
      events.map((e) => e.type),
    )
  } finally {
    await teardown(h)
  }
})

test('historyLimit caps history passed to a turn', async () => {
  const h = await setup({ historyLimit: 2 })
  try {
    spyLog.length = 0
    await spawnSpy(h, 'ann', 'Ann', 1, 'a')
    await spawnSpy(h, 'bob', 'Bob', 2, 'b')
    const room = h.rooms.create({ name: 'r', members: ['ann', 'bob'] })
    await collect(h.rooms.post(room.id, 'first'))
    spyLog.length = 0
    await collect(h.rooms.post(room.id, 'second'))
    for (const rec of spyLog) {
      assert.ok(rec.input.history.length <= 2, `history length ${rec.input.history.length}`)
    }
  } finally {
    await teardown(h)
  }
})

test('content validation and unknown room', async () => {
  const h = await setup()
  try {
    await spawnSpy(h, 'ann', 'Ann', 1, 'a')
    const room = h.rooms.create({ name: 'r', members: ['ann'] })
    await assert.rejects(async () => {
      for await (const _ of h.rooms.post(room.id, '')) void _
    }, TypeError)
    await assert.rejects(async () => {
      for await (const _ of h.rooms.post(room.id, 'x'.repeat(8001))) void _
    }, TypeError)
    await assert.rejects(async () => {
      for await (const _ of h.rooms.post('room_missing', 'hi')) void _
    }, /not found/)
  } finally {
    await teardown(h)
  }
})

test('abort during first speaker skips it and stops', async () => {
  const h = await setup()
  try {
    await spawnSpy(h, 'ann', 'Ann', 1, 'a', 50)
    await spawnSpy(h, 'bob', 'Bob', 2, 'b', 50)
    const room = h.rooms.create({ name: 'r', members: ['ann', 'bob'] })
    const controller = new AbortController()
    const events: import('../../src/contracts/rooms.ts').RoomEvent[] = []
    const run = (async () => {
      for await (const ev of h.rooms.post(room.id, 'hi', { signal: controller.signal })) {
        events.push(ev)
        if (ev.type === 'speaker' && ev.agentId === 'ann') {
          controller.abort()
        }
      }
    })()
    await run
    const skipped = events.find((e) => e.type === 'skipped')
    assert.ok(skipped && skipped.type === 'skipped')
    assert.equal(skipped.agentId, 'ann')
    assert.ok(!events.some((e) => e.type === 'speaker' && e.agentId === 'bob'))
    assert.ok(events.some((e) => e.type === 'round-end'))
  } finally {
    await teardown(h)
  }
})

test('parseTeamJson', () => {
  const plain = parseTeamJson('{"hires":[{"name":"A","role":"r","rationale":"why"}]}')
  assert.equal(plain.length, 1)
  assert.equal(plain[0]?.name, 'A')

  const prose = parseTeamJson('Sure! {"hires":[{"name":"B","role":"r","rationale":""}]} done')
  assert.equal(prose[0]?.name, 'B')

  const fenced = parseTeamJson('```json\n{"hires":[{"name":"C","role":"r","rationale":"x"}]}\n```')
  assert.equal(fenced[0]?.name, 'C')

  const trimmed = parseTeamJson('{"hires":[{"name":"  D  ","role":"  role  ","rationale":"  why  "}]}')
  assert.equal(trimmed[0]?.name, 'D')
  assert.equal(trimmed[0]?.role, 'role')
  assert.equal(trimmed[0]?.rationale, 'why')

  assert.throws(() => parseTeamJson('{"hires":[]}'), /invalid team proposal/)
  assert.throws(
    () =>
      parseTeamJson(
        '{"hires":[{"name":"a","role":"r","rationale":""},{"name":"b","role":"r","rationale":""},{"name":"c","role":"r","rationale":""},{"name":"d","role":"r","rationale":""}]}',
      ),
    /invalid team proposal/,
  )
  assert.throws(() => parseTeamJson('{"hires":[{"name":"a","rationale":""}]}'), /invalid team proposal/)
  assert.throws(() => parseTeamJson('not json at all'), /invalid team proposal/)
})

test('proposeTeam parses hires and spawns nothing', async () => {
  const h = await setup()
  try {
    spyLog.length = 0
    await spawnSpy(
      h,
      'lead',
      'Lead',
      5,
      '{"hires":[{"name":"Data Diver","role":"analyst","rationale":"crunch numbers"}]}',
    )
    const proposal = await h.rooms.proposeTeam('lead', 'analyze the data')
    assert.equal(proposal.status, 'proposed')
    assert.equal(proposal.leadId, 'lead')
    assert.equal(proposal.hires.length, 1)
    assert.equal(proposal.hires[0]?.name, 'Data Diver')
    assert.ok(proposal.id.startsWith('team_'))

    const stored = await h.app.ctx.store.collection('teamProposals').get(proposal.id)
    assert.ok(stored)

    const leadRecord = spyLog.find((r) => r.agentName === 'Lead')
    assert.ok(leadRecord)
    assert.ok(leadRecord.input.prompt.includes('analyze the data'))

    assert.equal(h.app.ctx.agents.list().length, 1)
    const dmCount = await h.app.ctx.store.collection('messages').count({ scope: 'agent:lead' })
    assert.equal(dmCount, 0)
  } finally {
    await teardown(h)
  }
})

test('hire denied by user', async () => {
  const h = await setup({ cheapDriver: { name: 'driver-stub', config: { template: 'hired: {prompt}' } } })
  try {
    await spawnSpy(
      h,
      'lead',
      'Lead',
      5,
      '{"hires":[{"name":"Data Diver","role":"analyst","rationale":"crunch numbers"}]}',
    )
    const proposal = await h.rooms.proposeTeam('lead', 'analyze the data')

    h.app.ctx.on('whales/approval-requested', (req: { id: string }) => {
      h.app.ctx.approvals.answer(req.id, 'deny')
    })

    await assert.rejects(
      () => h.rooms.hire(proposal.id),
      /not approved/,
    )
    const stored = await h.app.ctx.store.collection('teamProposals').get(proposal.id)
    assert.equal(stored?.status, 'rejected')
    assert.equal(h.app.ctx.agents.list().length, 1)
  } finally {
    await teardown(h)
  }
})

test('hire approved spawns agent', async () => {
  const h = await setup({ cheapDriver: { name: 'driver-stub', config: { template: 'hired: {prompt}' } } })
  try {
    await spawnSpy(
      h,
      'lead',
      'Lead',
      5,
      '{"hires":[{"name":"Data Diver","role":"analyst","rationale":"crunch numbers"}]}',
    )
    const proposal = await h.rooms.proposeTeam('lead', 'analyze the data')

    let requestedKind: string | undefined
    h.app.ctx.on('whales/approval-requested', (req: { id: string; action: { kind: string } }) => {
      requestedKind = req.action.kind
      h.app.ctx.approvals.answer(req.id, 'allow-once')
    })

    const ids = await h.rooms.hire(proposal.id)
    assert.deepEqual(ids, ['data-diver'])
    assert.equal(requestedKind, 'agent.hire')

    const handle = h.app.ctx.agents.get('data-diver')
    assert.ok(handle)
    assert.equal(handle.state, 'active')
    assert.equal(handle.spec.seniority, 4)
    assert.equal(handle.spec.hiredBy, 'lead')
    assert.equal(handle.spec.permissionMode, 'ask')
    assert.equal(handle.spec.driver.name, 'driver-stub')
    assert.ok(handle.spec.plugins.some((p) => p.name === 'memory'))

    const stored = await h.app.ctx.store.collection('teamProposals').get(proposal.id)
    assert.equal(stored?.status, 'hired')

    const agentRecord = await h.app.ctx.store.collection('agents').get('data-diver')
    assert.ok(agentRecord)
  } finally {
    await teardown(h)
  }
})

test('hire denied by global rule without approval request', async () => {
  const h = await setup({ cheapDriver: { name: 'driver-stub', config: { template: 'hired: {prompt}' } } })
  try {
    await spawnSpy(
      h,
      'lead',
      'Lead',
      5,
      '{"hires":[{"name":"Data Diver","role":"analyst","rationale":"crunch numbers"}]}',
    )
    const proposal = await h.rooms.proposeTeam('lead', 'analyze the data')

    const rules = h.app.ctx.get('rules')
    assert.ok(rules)
    rules.add('deny hiring agents')

    let requested = false
    h.app.ctx.on('whales/approval-requested', () => {
      requested = true
    })

    await assert.rejects(() => h.rooms.hire(proposal.id), /not approved/)
    assert.equal(requested, false)
  } finally {
    await teardown(h)
  }
})

test('hire name collision appends suffix', async () => {
  const h = await setup({ cheapDriver: { name: 'driver-stub', config: { template: 'hired: {prompt}' } } })
  try {
    await spawnSpy(h, 'data-diver', 'Data Diver', 3, 'x')
    await spawnSpy(
      h,
      'lead',
      'Lead',
      5,
      '{"hires":[{"name":"Data Diver","role":"analyst","rationale":"crunch numbers"}]}',
    )
    const proposal = await h.rooms.proposeTeam('lead', 'analyze the data')

    h.app.ctx.on('whales/approval-requested', (req: { id: string }) => {
      h.app.ctx.approvals.answer(req.id, 'allow-once')
    })

    const ids = await h.rooms.hire(proposal.id)
    assert.deepEqual(ids, ['data-diver-2'])
    // The display name is made unique as well, so the room never shows two "Data Diver"s.
    assert.equal(h.app.ctx.agents.get('data-diver-2')?.spec.name, 'Data Diver 2')
  } finally {
    await teardown(h)
  }
})

test('hiring a proposal twice rejects', async () => {
  const h = await setup({ cheapDriver: { name: 'driver-stub', config: { template: 'hired: {prompt}' } } })
  try {
    await spawnSpy(
      h,
      'lead',
      'Lead',
      5,
      '{"hires":[{"name":"Data Diver","role":"analyst","rationale":"crunch numbers"}]}',
    )
    const proposal = await h.rooms.proposeTeam('lead', 'analyze the data')

    h.app.ctx.on('whales/approval-requested', (req: { id: string }) => {
      h.app.ctx.approvals.answer(req.id, 'allow-once')
    })

    await h.rooms.hire(proposal.id)
    await assert.rejects(() => h.rooms.hire(proposal.id))
  } finally {
    await teardown(h)
  }
})
