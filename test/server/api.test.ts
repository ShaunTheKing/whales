import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, type App } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import { createApi } from '../../src/server/api.ts'
import type {} from '../../src/contracts/index.ts'
import type { AgentSpec } from '../../src/contracts/core.ts'
import type { DriverEvent } from '../../src/contracts/driver.ts'
import type { RoomEvent } from '../../src/contracts/rooms.ts'

interface Ctx {
  app: App
  api: ReturnType<typeof createApi>
  tmp: string
}

async function setup(opts?: { mutateConfig?: (cfg: ReturnType<typeof defaultConfig>) => void }): Promise<Ctx> {
  const tmp = await mkdtemp(join(tmpdir(), 'whales-api-'))
  const cfg = defaultConfig({ env: {}, home: tmp, cwd: tmp })
  opts?.mutateConfig?.(cfg)
  const app = await createApp({
    config: cfg,
    storePath: ':memory:',
    services: { skills: { dir: join(tmp, 'skills') } },
  })
  const api = createApi(app)
  return { app, api, tmp }
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.app.stop()
  await rm(ctx.tmp, { recursive: true, force: true })
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }
}

async function ndjson<T>(res: Response): Promise<T[]> {
  const text = await res.text()
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T)
}

function stubSpec(id: string, extra?: Partial<AgentSpec>): AgentSpec {
  return {
    id,
    name: id,
    seniority: 1,
    driver: { name: 'driver-stub', config: { template: 'echo: {prompt}' } },
    plugins: [],
    ...extra,
  }
}

describe('api', () => {
  let ctx: Ctx
  before(async () => {
    ctx = await setup()
  })
  after(async () => {
    await teardown(ctx)
  })

  test('health', async () => {
    const res = await ctx.api.request('/health')
    assert.equal(res.status, 200)
    const body = (await res.json()) as { ok: boolean; agents: number; pendingApprovals: number }
    assert.equal(body.ok, true)
    assert.equal(body.agents, 0)
    assert.equal(body.pendingApprovals, 0)
  })

  test('agents lifecycle', async () => {
    const spec = stubSpec('a')
    const created = await ctx.api.request('/agents', jsonInit({ spec }))
    assert.equal(created.status, 201)
    const view = (await created.json()) as Record<string, unknown>
    assert.equal(view.id, 'a')
    assert.equal(view.name, 'a')
    assert.equal(view.state, 'active')
    assert.equal(view.persisted, true)
    assert.deepEqual(view.driver, { name: 'driver-stub' })
    assert.deepEqual(view.plugins, [])

    const dup = await ctx.api.request('/agents', jsonInit({ spec }))
    assert.equal(dup.status, 409)

    const bad = await ctx.api.request('/agents', jsonInit({ spec: { ...spec, id: 'Bad Id' } }))
    assert.equal(bad.status, 400)
    const badBody = (await bad.json()) as { error: string }
    assert.equal(typeof badBody.error, 'string')

    const nonJson = await ctx.api.request('/agents', {
      method: 'POST',
      body: 'not json',
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(nonJson.status, 400)
    assert.equal(((await nonJson.json()) as { error: string }).error, 'invalid JSON body')

    const list = await ctx.api.request('/agents')
    assert.equal(list.status, 200)
    const listBody = (await list.json()) as { id: string }[]
    assert.ok(listBody.some((v) => v.id === 'a'))

    const got = await ctx.api.request('/agents/a')
    assert.equal(got.status, 200)
    const gotBody = (await got.json()) as { agent: { id: string }; spec: AgentSpec }
    assert.equal(gotBody.agent.id, 'a')
    assert.deepEqual(gotBody.spec, spec)

    const missing = await ctx.api.request('/agents/nope')
    assert.equal(missing.status, 404)

    const stopped = await ctx.api.request('/agents/a/stop', { method: 'POST' })
    assert.equal(stopped.status, 200)
    assert.equal(((await stopped.json()) as { state: string }).state, 'stopped')

    const started = await ctx.api.request('/agents/a/start', { method: 'POST' })
    assert.equal(started.status, 200)
    assert.equal(((await started.json()) as { state: string }).state, 'active')

    const del = await ctx.api.request('/agents/a', { method: 'DELETE' })
    assert.equal(del.status, 204)
    const after = await ctx.api.request('/agents/a')
    assert.equal(after.status, 404)
  })

  test('turn streams and persists messages', async () => {
    const spec = stubSpec('t')
    const created = await ctx.api.request('/agents', jsonInit({ spec }))
    assert.equal(created.status, 201)

    const res = await ctx.api.request('/agents/t/turn', jsonInit({ prompt: 'hi' }))
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /application\/x-ndjson/)
    const events = await ndjson<DriverEvent>(res)
    const text = events
      .filter((e): e is { type: 'text'; delta: string } => e.type === 'text')
      .map((e) => e.delta)
      .join('')
    assert.equal(text, 'echo: hi')
    const last = events.at(-1)
    assert.ok(last)
    assert.equal(last.type, 'done')
    assert.equal((last as { type: 'done'; stopReason: string }).stopReason, 'end')

    const msgs = await ctx.api.request('/agents/t/messages')
    assert.equal(msgs.status, 200)
    const msgsBody = (await msgs.json()) as { role: string; content: string }[]
    assert.equal(msgsBody.length, 2)
    assert.equal(msgsBody[0]?.role, 'user')
    assert.equal(msgsBody[0]?.content, 'hi')
    assert.equal(msgsBody[1]?.role, 'assistant')
    assert.equal(msgsBody[1]?.content, 'echo: hi')

    const empty = await ctx.api.request('/agents/t/turn', jsonInit({ prompt: '' }))
    assert.equal(empty.status, 400)

    const unknown = await ctx.api.request('/agents/nope/turn', jsonInit({ prompt: 'hi' }))
    assert.equal(unknown.status, 404)

    await ctx.api.request('/agents/t', { method: 'DELETE' })
  })

  test('turn auto-starts a stopped persisted agent', async () => {
    const spec = stubSpec('auto')
    await ctx.api.request('/agents', jsonInit({ spec }))
    const stopped = await ctx.api.request('/agents/auto/stop', { method: 'POST' })
    assert.equal(stopped.status, 200)
    assert.equal(((await stopped.json()) as { state: string }).state, 'stopped')

    const res = await ctx.api.request('/agents/auto/turn', jsonInit({ prompt: 'hi' }))
    assert.equal(res.status, 200)
    const events = await ndjson<DriverEvent>(res)
    assert.equal(events.at(-1)?.type, 'done')

    await ctx.api.request('/agents/auto', { method: 'DELETE' })
  })

  test('turn aborts on client disconnect', async () => {
    const spec = stubSpec('abort', {
      driver: {
        name: 'driver-stub',
        config: {
          delayMs: 30,
          script: ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'],
        },
      },
    })
    await ctx.api.request('/agents', jsonInit({ spec }))

    const ac = new AbortController()
    const res = await ctx.api.request('/agents/abort/turn', {
      ...jsonInit({ prompt: 'go' }),
      signal: ac.signal,
    })
    assert.equal(res.status, 200)
    const reader = res.body?.getReader()
    assert.ok(reader)
    await reader.read()
    ac.abort()

    const deadline = Date.now() + 200
    while (Date.now() < deadline) {
      if (ctx.app.ctx.agents.get('abort')?.runtime?.busy === false) break
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(ctx.app.ctx.agents.get('abort')?.runtime?.busy, false)

    await ctx.api.request('/agents/abort', { method: 'DELETE' })
  })

  test('rooms', async () => {
    await ctx.api.request('/agents', jsonInit({ spec: stubSpec('r1') }))
    await ctx.api.request('/agents', jsonInit({ spec: stubSpec('r2') }))

    const badMembers = await ctx.api.request('/rooms', jsonInit({ name: 'bad', members: ['ghost'] }))
    assert.equal(badMembers.status, 400)

    const created = await ctx.api.request('/rooms', jsonInit({ name: 'room', members: ['r1', 'r2'] }))
    assert.equal(created.status, 201)
    const room = (await created.json()) as { id: string; name: string; members: string[] }
    assert.equal(room.name, 'room')
    assert.deepEqual(room.members, ['r1', 'r2'])

    const got = await ctx.api.request(`/rooms/${room.id}`)
    assert.equal(got.status, 200)
    const gotBody = (await got.json()) as { room: { id: string }; order: string[]; notes: unknown[] }
    assert.equal(gotBody.room.id, room.id)
    assert.ok(Array.isArray(gotBody.order))
    assert.ok(Array.isArray(gotBody.notes))

    const post = await ctx.api.request(`/rooms/${room.id}/post`, jsonInit({ content: 'hello' }))
    assert.equal(post.status, 200)
    assert.match(post.headers.get('content-type') ?? '', /application\/x-ndjson/)
    const events = await ndjson<RoomEvent>(post)
    const types = events.map((e) => e.type)
    assert.equal(types[0], 'round-start')
    assert.ok(types.includes('speaker'))
    assert.ok(types.includes('message'))
    assert.equal(types.at(-1), 'round-end')
    assert.ok(types.indexOf('round-start') < types.indexOf('speaker'))
    assert.ok(types.indexOf('speaker') < types.indexOf('message'))
    assert.ok(types.indexOf('message') < types.indexOf('round-end'))

    const msgs = await ctx.api.request(`/rooms/${room.id}/messages`)
    assert.equal(msgs.status, 200)
    const msgsBody = (await msgs.json()) as { speaker: string; content: string }[]
    assert.ok(msgsBody.some((m) => m.speaker === 'user' && m.content === 'hello'))
    assert.ok(msgsBody.some((m) => m.speaker !== 'user'))

    const note = await ctx.api.request(`/rooms/${room.id}/notes`, jsonInit({ text: 'a note' }))
    assert.equal(note.status, 201)
    const noteBody = (await note.json()) as { author: string; text: string }
    assert.equal(noteBody.author, 'user')
    assert.equal(noteBody.text, 'a note')

    const already = await ctx.api.request(`/rooms/${room.id}/members`, jsonInit({ agentId: 'r1' }))
    assert.equal(already.status, 409)
    await ctx.api.request('/agents', jsonInit({ spec: stubSpec('r3') }))
    const added = await ctx.api.request(`/rooms/${room.id}/members`, jsonInit({ agentId: 'r3' }))
    assert.equal(added.status, 200)
    assert.ok(((await added.json()) as { members: string[] }).members.includes('r3'))
    const removed = await ctx.api.request(`/rooms/${room.id}/members/r1`, { method: 'DELETE' })
    assert.equal(removed.status, 200)
    const removedBody = (await removed.json()) as { members: string[] }
    assert.ok(!removedBody.members.includes('r1'))

    const del = await ctx.api.request(`/rooms/${room.id}`, { method: 'DELETE' })
    assert.equal(del.status, 204)

    await ctx.api.request('/agents/r1', { method: 'DELETE' })
    await ctx.api.request('/agents/r2', { method: 'DELETE' })
    await ctx.api.request('/agents/r3', { method: 'DELETE' })
  })

  test('approvals', async () => {
    const approvals = ctx.app.ctx.get('approvals')
    assert.ok(approvals)
    const pending = approvals.authorize(
      { kind: 'shell', target: 'ls', agentId: 'a', summary: 'list' },
      { mode: 'ask' },
    )

    const list = await ctx.api.request('/approvals')
    assert.equal(list.status, 200)
    const listBody = (await list.json()) as { id: string; status: string }[]
    const req = listBody.find((r) => r.status === 'pending')
    assert.ok(req)

    const answered = await ctx.api.request(`/approvals/${req.id}`, jsonInit({ decision: 'allow-once' }))
    assert.equal(answered.status, 200)
    assert.deepEqual(await answered.json(), { ok: true })

    const auth = await pending
    assert.equal(auth.allowed, true)

    const again = await ctx.api.request(`/approvals/${req.id}`, jsonInit({ decision: 'allow-once' }))
    assert.equal(again.status, 409)

    const unknown = await ctx.api.request('/approvals/nope', jsonInit({ decision: 'allow-once' }))
    assert.equal(unknown.status, 404)

    const badDecision = await ctx.api.request(`/approvals/${req.id}`, jsonInit({ decision: 'maybe' }))
    assert.equal(badDecision.status, 400)

    const all = await ctx.api.request('/approvals?status=all')
    assert.equal(all.status, 200)
    const allBody = (await all.json()) as { id: string; status: string }[]
    const found = allBody.find((r) => r.id === req.id)
    assert.ok(found)
    assert.equal(found.status, 'allowed')
  })

  test('rules', async () => {
    const created = await ctx.api.request('/rules', jsonInit({ sentence: 'deny running commands matching rm *' }))
    assert.equal(created.status, 201)
    const rule = (await created.json()) as { id: string; sentence: string }
    assert.equal(typeof rule.id, 'string')

    const invalid = await ctx.api.request('/rules', jsonInit({ sentence: 'not a rule at all' }))
    assert.equal(invalid.status, 400)

    const list = await ctx.api.request('/rules')
    assert.equal(list.status, 200)
    const listBody = (await list.json()) as { id: string }[]
    assert.ok(listBody.some((r) => r.id === rule.id))

    const spec = stubSpec('rules-agent', { rules: ['deny running commands matching rm *'] })
    await ctx.api.request('/agents', jsonInit({ spec }))
    const scoped = await ctx.api.request('/rules?agent=rules-agent')
    assert.equal(scoped.status, 200)
    const scopedBody = (await scoped.json()) as { spec?: boolean }[]
    assert.ok(scopedBody.some((r) => r.spec === true))

    const del = await ctx.api.request(`/rules/${rule.id}`, { method: 'DELETE' })
    assert.equal(del.status, 204)

    await ctx.api.request('/agents/rules-agent', { method: 'DELETE' })
  })

  test('skills', async () => {
    const dir = await mkdtemp(join(ctx.tmp, 'skill-'))
    const skillPath = join(dir, 'SKILL.md')
    await writeFile(
      skillPath,
      ['---', 'name: demo-skill', 'description: a demo', '---', '', 'Do the demo thing.'].join('\n'),
      'utf8',
    )

    const preview = await ctx.api.request('/skills/preview', jsonInit({ source: skillPath }))
    assert.equal(preview.status, 200)
    const previewBody = (await preview.json()) as { name: string; hash: string }
    assert.equal(previewBody.name, 'demo-skill')
    assert.equal(typeof previewBody.hash, 'string')

    const installed = await ctx.api.request(
      '/skills/install',
      jsonInit({ source: skillPath, hash: previewBody.hash }),
    )
    assert.equal(installed.status, 201)

    const wrongHash = await ctx.api.request(
      '/skills/install',
      jsonInit({ source: skillPath, hash: 'deadbeef' }),
    )
    assert.equal(wrongHash.status, 409)

    const list = await ctx.api.request('/skills')
    assert.equal(list.status, 200)
    const listBody = (await list.json()) as { name: string }[]
    assert.ok(listBody.some((s) => s.name === 'demo-skill'))

    const del = await ctx.api.request('/skills/demo-skill', { method: 'DELETE' })
    assert.equal(del.status, 204)
  })

  test('routines', async () => {
    await ctx.api.request('/agents', jsonInit({ spec: stubSpec('rt') }))

    const created = await ctx.api.request(
      '/routines',
      jsonInit({ agentId: 'rt', prompt: 'hi', everyMinutes: 60, quiet: false, enabled: true }),
    )
    assert.equal(created.status, 201)
    const routine = (await created.json()) as { id: string; enabled: boolean }
    assert.equal(typeof routine.id, 'string')

    const patched = await ctx.api.request(`/routines/${routine.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(patched.status, 200)
    assert.equal(((await patched.json()) as { enabled: boolean }).enabled, false)

    const run = await ctx.api.request(`/routines/${routine.id}/run`, { method: 'POST' })
    assert.equal(run.status, 200)
    const runBody = (await run.json()) as { output?: string }
    assert.equal(typeof runBody.output, 'string')

    const del = await ctx.api.request(`/routines/${routine.id}`, { method: 'DELETE' })
    assert.equal(del.status, 204)

    await ctx.api.request('/agents/rt', { method: 'DELETE' })
  })

  test('team', async () => {
    const leadSpec = stubSpec('lead', {
      driver: {
        name: 'driver-stub',
        config: { script: ['{"hires":[{"name":"Helper","role":"assist","rationale":"r"}]}'] },
      },
    })
    await ctx.api.request('/agents', jsonInit({ spec: leadSpec }))

    const proposed = await ctx.api.request('/team/propose', jsonInit({ leadId: 'lead', goal: 'build it' }))
    assert.equal(proposed.status, 201)
    const proposal = (await proposed.json()) as { id: string; leadId: string; status: string }
    assert.equal(proposal.leadId, 'lead')

    const proposals = await ctx.api.request('/team/proposals')
    assert.equal(proposals.status, 200)
    const proposalsBody = (await proposals.json()) as { id: string }[]
    assert.ok(proposalsBody.some((p) => p.id === proposal.id))

    const denyListener = (req: { id: string }) => {
      ctx.app.ctx.get('approvals')?.answer(req.id, 'deny')
    }
    const off_denyListener = ctx.app.ctx.on('whales/approval-requested', denyListener)
    const denied = await ctx.api.request(`/team/${proposal.id}/hire`, { method: 'POST' })
    assert.equal(denied.status, 403)
    off_denyListener()

    await ctx.api.request('/agents/lead', { method: 'DELETE' })
  })

  test('responses never contain secrets', async () => {
    const spec = stubSpec('secret', {
      driver: { name: 'driver-stub', config: { template: 'echo: {prompt}', apiKey: 'sk-should-not-leak' } },
    })
    // A spec carrying a secret value is refused, so keys can never be persisted or echoed back.
    const res = await ctx.api.request('/agents', jsonInit({ spec }))
    assert.equal(res.status, 400)
    assert.ok(!(await res.text()).includes('sk-should-not-leak'))
    const missing = await ctx.api.request('/agents/secret')
    assert.equal(missing.status, 404)
  })
})

describe('api team config', () => {
  let ctx: Ctx
  before(async () => {
    ctx = await setup({
      mutateConfig: (cfg) => {
        cfg.defaults.cheapDriver = { name: 'driver-stub' }
      },
    })
  })
  after(async () => {
    await teardown(ctx)
  })

  test('hire with cheapDriver configured', async () => {
    const leadSpec = stubSpec('lead2', {
      driver: {
        name: 'driver-stub',
        config: { script: ['{"hires":[{"name":"Helper","role":"assist","rationale":"r"}]}'] },
      },
    })
    await ctx.api.request('/agents', jsonInit({ spec: leadSpec }))
    const proposed = await ctx.api.request('/team/propose', jsonInit({ leadId: 'lead2', goal: 'g' }))
    assert.equal(proposed.status, 201)
    const proposal = (await proposed.json()) as { id: string }

    const allowListener = (req: { id: string }) => {
      ctx.app.ctx.get('approvals')?.answer(req.id, 'allow-once')
    }
    const off_allowListener = ctx.app.ctx.on('whales/approval-requested', allowListener)
    const hired = await ctx.api.request(`/team/${proposal.id}/hire`, { method: 'POST' })
    assert.equal(hired.status, 200)
    off_allowListener()

    await ctx.api.request('/agents/lead2', { method: 'DELETE' })
    await ctx.api.request('/agents/helper', { method: 'DELETE' })
  })
})
