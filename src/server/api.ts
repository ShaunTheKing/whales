import { Hono, type Context } from 'hono'
import { stream } from 'hono/streaming'
import type { App } from '../core/app.ts'
import type { AgentSpec, AgentId, RoomId } from '../contracts/core.ts'
import type { AgentHandle } from '../contracts/agents.ts'
import type { AgentRecord, MessageRecord } from '../contracts/agents.ts'
import type { Room, RoomMessage, RoomNote, TeamProposal } from '../contracts/rooms.ts'
import type { ApprovalRequest, ApprovalDecision } from '../contracts/approvals.ts'
import type { Rule } from '../contracts/rules.ts'
import type { SkillMeta, SkillPreview, Skill } from '../contracts/skills.ts'
import type { Routine, RoutineRun } from '../contracts/routines.ts'
import type { MemoryNote } from '../contracts/memory.ts'
import type { Checkpoint } from '../contracts/checkpoints.ts'
import { RuleParseError } from '../contracts/rules.ts'
import { SkillParseError } from '../services/skills.ts'

export interface AgentView {
  id: string
  name: string
  role?: string
  seniority: number
  state: 'stopped' | 'starting' | 'active' | 'failed' | 'disposed'
  persisted: boolean
  driver: { name: string; model?: string }
  plugins: string[]
  hiredBy?: string
}

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' ? value : undefined
}

function num(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function bool(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  return typeof value === 'boolean' ? value : undefined
}

function strArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key]
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    out.push(item)
  }
  return out
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await c.req.json()
  } catch {
    throw new TypeError('invalid JSON body')
  }
  if (!isRecord(parsed)) throw new TypeError('invalid JSON body')
  return parsed
}

function errorResponse(c: Context, err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof TypeError || err instanceof RuleParseError || err instanceof SkillParseError) {
    return c.json({ error: message }, 400)
  }
  if (message === 'invalid JSON body') return c.json({ error: message }, 400)
  if (/not approved/.test(message)) return c.json({ error: message }, 403)
  if (/already|not pending|changed/.test(message)) {
    return c.json({ error: message }, 409)
  }
  if (/not found|unknown/.test(message)) return c.json({ error: message }, 404)
  return c.json({ error: message }, 500)
}

function driverModel(spec: AgentSpec): string | undefined {
  const config = spec.driver.config
  if (!config) return undefined
  const model = config.model
  return typeof model === 'string' ? model : undefined
}

function viewFromSpec(spec: AgentSpec, persisted: boolean, state: AgentView['state']): AgentView {
  const view: AgentView = {
    id: spec.id,
    name: spec.name,
    seniority: spec.seniority,
    state,
    persisted,
    driver: { name: spec.driver.name },
    plugins: spec.plugins.map((p) => p.name),
  }
  if (spec.role !== undefined) view.role = spec.role
  const model = driverModel(spec)
  if (model !== undefined) view.driver.model = model
  if (spec.hiredBy !== undefined) view.hiredBy = spec.hiredBy
  return view
}

function viewFromHandle(handle: AgentHandle, persisted: boolean): AgentView {
  const view = viewFromSpec(handle.spec, persisted, handle.state)
  return view
}

function storedAgent(app: App, id: string): AgentRecord | undefined {
  return app.ctx.store.collection('agents').get(id)
}

export function agentView(app: App, id: string): AgentView | undefined {
  const handle = app.ctx.agents.get(id)
  const record = storedAgent(app, id)
  if (handle) return viewFromHandle(handle, record !== undefined)
  if (record) return viewFromSpec(record.spec, true, 'stopped')
  return undefined
}

async function ensureActiveAsync(app: App, id: string): Promise<AgentHandle | undefined> {
  const handle = app.ctx.agents.get(id)
  if (handle && handle.state === 'active') return handle
  const record = storedAgent(app, id)
  if (!record) return undefined
  return app.ctx.agents.spawn(record.spec, { persist: false })
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  if (parsed < 1) return 1
  if (parsed > 500) return 500
  return parsed
}

function registerAgents(app: App, api: Hono): void {
  api.get('/agents', (c) => {
    const store = app.ctx.store.collection('agents')
    const records = store.list()
    const ids = new Set<string>()
    for (const record of records) ids.add(record.id)
    for (const handle of app.ctx.agents.list()) ids.add(handle.id)
    const views: AgentView[] = []
    for (const id of [...ids].sort()) {
      const view = agentView(app, id)
      if (view) views.push(view)
    }
    return c.json(views)
  })

  api.post('/agents', async (c) => {
    const body = await readJson(c)
    const specRaw = body.spec
    if (!isRecord(specRaw)) throw new TypeError('missing spec')
    const spec = specRaw as unknown as AgentSpec
    const id = spec.id
    if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) throw new TypeError('invalid agent id')
    if (app.ctx.agents.get(id) || storedAgent(app, id)) {
      throw new Error(`agent ${id} already exists`)
    }
    const handle = await app.ctx.agents.spawn(spec)
    return c.json(viewFromHandle(handle, true), 201)
  })

  api.get('/agents/:id', (c) => {
    const id = c.req.param('id')
    const view = agentView(app, id)
    if (!view) return c.json({ error: `agent ${id} not found` }, 404)
    const handle = app.ctx.agents.get(id)
    const record = storedAgent(app, id)
    const spec = handle ? handle.spec : record?.spec
    if (!spec) return c.json({ error: `agent ${id} not found` }, 404)
    return c.json({ agent: view, spec })
  })

  api.delete('/agents/:id', async (c) => {
    const id = c.req.param('id')
    const handle = app.ctx.agents.get(id)
    const record = storedAgent(app, id)
    if (!handle && !record) return c.json({ error: `agent ${id} not found` }, 404)
    const forget = c.req.query('forget') === '1'
    if (handle) await app.ctx.agents.dispose(id)
    app.ctx.store.collection('agents').delete(id)
    if (forget) {
      app.ctx.store.collection('messages').clear(`agent:${id}`)
      app.ctx.store.collection('memories').clear(`agent:${id}`)
    }
    return c.body(null, 204)
  })

  api.post('/agents/:id/start', async (c) => {
    const id = c.req.param('id')
    const handle = await ensureActiveAsync(app, id)
    if (!handle) return c.json({ error: `agent ${id} not found` }, 404)
    return c.json(viewFromHandle(handle, storedAgent(app, id) !== undefined))
  })

  api.post('/agents/:id/stop', async (c) => {
    const id = c.req.param('id')
    const handle = app.ctx.agents.get(id)
    const record = storedAgent(app, id)
    if (!handle && !record) return c.json({ error: `agent ${id} not found` }, 404)
    if (handle) await app.ctx.agents.dispose(id)
    const view = agentView(app, id)
    if (!view) return c.json({ error: `agent ${id} not found` }, 404)
    return c.json(view)
  })

  api.get('/agents/:id/messages', (c) => {
    const id = c.req.param('id')
    if (!agentView(app, id)) return c.json({ error: `agent ${id} not found` }, 404)
    const limit = parseLimit(c.req.query('limit'), 100)
    const all = app.ctx.store.collection('messages').list({ scope: `agent:${id}`, order: 'asc' })
    const slice = all.slice(Math.max(0, all.length - limit))
    return c.json(
      slice.map((m: MessageRecord) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        turnId: m.turnId,
      })),
    )
  })

  api.get('/agents/:id/memories', (c) => {
    const id = c.req.param('id')
    if (!agentView(app, id)) return c.json({ error: `agent ${id} not found` }, 404)
    const notes = app.ctx.store.collection('memories').list({ scope: `agent:${id}`, order: 'asc' })
    return c.json(notes)
  })

  api.post('/agents/:id/turn', async (c) => {
    const id = c.req.param('id')
    const body = await readJson(c)
    const prompt = str(body, 'prompt')
    if (prompt === undefined || prompt.length < 1 || prompt.length > 20000) {
      throw new TypeError('prompt must be 1..20000 characters')
    }
    const handle = await ensureActiveAsync(app, id)
    if (!handle || !handle.runtime) return c.json({ error: `agent ${id} not found` }, 404)
    const runtime = handle.runtime
    const signal = c.req.raw.signal
    c.header('content-type', 'application/x-ndjson')
    return stream(c, async (s) => {
      for await (const event of runtime.turn(prompt, { signal })) {
        await s.write(`${JSON.stringify(event)}\n`)
      }
    })
  })
}

function registerRooms(app: App, api: Hono): void {
  const rooms = () => app.ctx.get('rooms')

  api.get('/rooms', (c) => {
    const service = rooms()
    if (!service) return c.json({ error: 'rooms service unavailable' }, 503)
    return c.json(service.list())
  })

  api.post('/rooms', async (c) => {
    const service = rooms()
    if (!service) return c.json({ error: 'rooms service unavailable' }, 503)
    const body = await readJson(c)
    const name = str(body, 'name')
    const members = strArray(body, 'members')
    if (name === undefined || members === undefined) throw new TypeError('name and members are required')
    let room: Room
    try {
      room = service.create({ name, members })
    } catch (err) {
      // Bad member ids are a problem with the request body, not a missing URL resource.
      throw new TypeError(err instanceof Error ? err.message : String(err))
    }
    return c.json(room, 201)
  })

  api.get('/rooms/:id', (c) => {
    const service = rooms()
    if (!service) return c.json({ error: 'rooms service unavailable' }, 503)
    const id = c.req.param('id')
    const room = service.get(id)
    if (!room) return c.json({ error: `room ${id} not found` }, 404)
    return c.json({ room, order: service.order(id), notes: service.notes(id) })
  })

  api.delete('/rooms/:id', (c) => {
    const service = rooms()
    if (!service) return c.json({ error: 'rooms service unavailable' }, 503)
    const id = c.req.param('id')
    if (!service.delete(id)) return c.json({ error: `room ${id} not found` }, 404)
    return c.body(null, 204)
  })

  api.get('/rooms/:id/messages', (c) => {
    const service = rooms()
    if (!service) return c.json({ error: 'rooms service unavailable' }, 503)
    const id = c.req.param('id')
    if (!service.get(id)) return c.json({ error: `room ${id} not found` }, 404)
    const limit = parseLimit(c.req.query('limit'), 100)
    return c.json(service.history(id, limit))
  })

  api.post('/rooms/:id/notes', async (c) => {
    const service = rooms()
    if (!service) return c.json({ error: 'rooms service unavailable' }, 503)
    const id = c.req.param('id')
    if (!service.get(id)) return c.json({ error: `room ${id} not found` }, 404)
    const body = await readJson(c)
    const text = str(body, 'text')
    if (text === undefined) throw new TypeError('text is required')
    const note = service.addNote(id, 'user', text)
    return c.json(note, 201)
  })

  api.post('/rooms/:id/members', async (c) => {
    const service = rooms()
    if (!service) return c.json({ error: 'rooms service unavailable' }, 503)
    const id = c.req.param('id')
    const body = await readJson(c)
    const agentId = str(body, 'agentId')
    if (agentId === undefined) throw new TypeError('agentId is required')
    const room = service.addMember(id, agentId)
    return c.json(room)
  })

  api.delete('/rooms/:id/members/:agentId', (c) => {
    const service = rooms()
    if (!service) return c.json({ error: 'rooms service unavailable' }, 503)
    const id = c.req.param('id')
    const agentId = c.req.param('agentId')
    const room = service.removeMember(id, agentId)
    return c.json(room)
  })

  api.post('/rooms/:id/post', async (c) => {
    const service = rooms()
    if (!service) return c.json({ error: 'rooms service unavailable' }, 503)
    const id = c.req.param('id')
    const room = service.get(id)
    if (!room) return c.json({ error: `room ${id} not found` }, 404)
    const body = await readJson(c)
    const content = str(body, 'content')
    if (content === undefined) throw new TypeError('content is required')
    for (const member of room.members) {
      try {
        await ensureActiveAsync(app, member)
      } catch {
        // failures are ignored: the room reports them as skipped
      }
    }
    const signal = c.req.raw.signal
    c.header('content-type', 'application/x-ndjson')
    return stream(c, async (s) => {
      for await (const event of service.post(id, content, { signal })) {
        await s.write(`${JSON.stringify(event)}\n`)
      }
    })
  })
}

function registerApprovals(app: App, api: Hono): void {
  const approvals = () => app.ctx.get('approvals')

  api.get('/approvals', (c) => {
    const service = approvals()
    if (!service) return c.json({ error: 'approvals service unavailable' }, 503)
    const status = c.req.query('status') ?? 'pending'
    if (status === 'all') {
      const all = app.ctx.store.collection('approvals').list({ order: 'desc', limit: 100 })
      return c.json(all)
    }
    return c.json(service.pending())
  })

  api.post('/approvals/:id', async (c) => {
    const service = approvals()
    if (!service) return c.json({ error: 'approvals service unavailable' }, 503)
    const id = c.req.param('id')
    const body = await readJson(c)
    const decision = str(body, 'decision')
    if (decision !== 'allow-once' && decision !== 'allow-always' && decision !== 'deny') {
      throw new TypeError('invalid decision')
    }
    const note = str(body, 'note')
    const ok = service.answer(id, decision as ApprovalDecision, note)
    if (ok) return c.json({ ok: true })
    const existing = service.get(id)
    if (!existing) return c.json({ error: `approval ${id} not found` }, 404)
    return c.json({ error: `approval ${id} not pending` }, 409)
  })
}

function registerRules(app: App, api: Hono): void {
  const rules = () => app.ctx.get('rules')

  api.get('/rules', (c) => {
    const service = rules()
    if (!service) return c.json({ error: 'rules service unavailable' }, 503)
    const agent = c.req.query('agent')
    const scope = agent ? (`agent:${agent}` as const) : undefined
    const list: (Rule | { id: string; scope: string; sentence: string; spec: true })[] = service.list(scope)
    if (agent) {
      const record = storedAgent(app, agent)
      const specRules = record?.spec.rules ?? []
      specRules.forEach((sentence, index) => {
        list.push({ id: `spec:${index}`, scope: `agent:${agent}`, sentence, spec: true })
      })
    }
    return c.json(list)
  })

  api.post('/rules', async (c) => {
    const service = rules()
    if (!service) return c.json({ error: 'rules service unavailable' }, 503)
    const body = await readJson(c)
    const sentence = str(body, 'sentence')
    if (sentence === undefined) throw new TypeError('sentence is required')
    const agentId = str(body, 'agentId')
    const scope = agentId ? (`agent:${agentId}` as const) : undefined
    const rule = service.add(sentence, scope)
    return c.json(rule, 201)
  })

  api.delete('/rules/:id', (c) => {
    const service = rules()
    if (!service) return c.json({ error: 'rules service unavailable' }, 503)
    const id = c.req.param('id')
    if (!service.remove(id)) return c.json({ error: `rule ${id} not found` }, 404)
    return c.body(null, 204)
  })
}

function registerSkills(app: App, api: Hono): void {
  const skills = () => app.ctx.get('skills')

  api.get('/skills', async (c) => {
    const service = skills()
    if (!service) return c.json({ error: 'skills service unavailable' }, 503)
    const list: SkillMeta[] = await service.list()
    return c.json(list)
  })

  api.post('/skills/preview', async (c) => {
    const service = skills()
    if (!service) return c.json({ error: 'skills service unavailable' }, 503)
    const body = await readJson(c)
    const source = str(body, 'source')
    if (source === undefined) throw new TypeError('source is required')
    const preview: SkillPreview = await service.preview(source)
    return c.json(preview)
  })

  api.post('/skills/install', async (c) => {
    const service = skills()
    if (!service) return c.json({ error: 'skills service unavailable' }, 503)
    const body = await readJson(c)
    const source = str(body, 'source')
    const hash = str(body, 'hash')
    if (source === undefined || hash === undefined) throw new TypeError('source and hash are required')
    const skill: Skill = await service.install(source, hash)
    return c.json(skill, 201)
  })

  api.delete('/skills/:name', async (c) => {
    const service = skills()
    if (!service) return c.json({ error: 'skills service unavailable' }, 503)
    const name = c.req.param('name')
    const removed = await service.remove(name)
    if (!removed) return c.json({ error: `skill ${name} not found` }, 404)
    return c.body(null, 204)
  })
}

function registerRoutines(app: App, api: Hono): void {
  const routines = () => app.ctx.get('routines')

  api.get('/routines', (c) => {
    const service = routines()
    if (!service) return c.json({ error: 'routines service unavailable' }, 503)
    const agent = c.req.query('agent')
    return c.json(service.list(agent))
  })

  api.post('/routines', async (c) => {
    const service = routines()
    if (!service) return c.json({ error: 'routines service unavailable' }, 503)
    const body = await readJson(c)
    const agentId = str(body, 'agentId')
    const prompt = str(body, 'prompt')
    const everyMinutes = num(body, 'everyMinutes')
    const quiet = bool(body, 'quiet')
    const enabled = bool(body, 'enabled')
    if (agentId === undefined || prompt === undefined || everyMinutes === undefined) {
      throw new TypeError('agentId, prompt and everyMinutes are required')
    }
    const routine: Routine = service.add({
      agentId,
      prompt,
      everyMinutes,
      quiet: quiet ?? false,
      enabled: enabled ?? true,
    })
    return c.json(routine, 201)
  })

  api.patch('/routines/:id', async (c) => {
    const service = routines()
    if (!service) return c.json({ error: 'routines service unavailable' }, 503)
    const id = c.req.param('id')
    const body = await readJson(c)
    const patch: Partial<Pick<Routine, 'prompt' | 'everyMinutes' | 'window' | 'quiet' | 'enabled'>> = {}
    const prompt = str(body, 'prompt')
    if (prompt !== undefined) patch.prompt = prompt
    const everyMinutes = num(body, 'everyMinutes')
    if (everyMinutes !== undefined) patch.everyMinutes = everyMinutes
    const quiet = bool(body, 'quiet')
    if (quiet !== undefined) patch.quiet = quiet
    const enabled = bool(body, 'enabled')
    if (enabled !== undefined) patch.enabled = enabled
    const routine = service.update(id, patch)
    return c.json(routine)
  })

  api.delete('/routines/:id', (c) => {
    const service = routines()
    if (!service) return c.json({ error: 'routines service unavailable' }, 503)
    const id = c.req.param('id')
    if (!service.remove(id)) return c.json({ error: `routine ${id} not found` }, 404)
    return c.body(null, 204)
  })

  api.post('/routines/:id/run', async (c) => {
    const service = routines()
    if (!service) return c.json({ error: 'routines service unavailable' }, 503)
    const id = c.req.param('id')
    const routine = service.list().find((r) => r.id === id)
    if (!routine) return c.json({ error: `routine ${id} not found` }, 404)
    const handle = await ensureActiveAsync(app, routine.agentId)
    if (!handle) return c.json({ error: `agent ${routine.agentId} not found` }, 404)
    const run: RoutineRun = await service.runNow(id)
    return c.json(run)
  })
}

function registerCheckpoints(app: App, api: Hono): void {
  const checkpoints = () => app.ctx.get('checkpoints')

  api.get('/agents/:id/checkpoints', (c) => {
    const service = checkpoints()
    if (!service) return c.json({ error: 'checkpoints service unavailable' }, 503)
    const id = c.req.param('id')
    if (!agentView(app, id)) return c.json({ error: `agent ${id} not found` }, 404)
    return c.json(service.list(id))
  })

  api.post('/agents/:id/checkpoints', async (c) => {
    const service = checkpoints()
    if (!service) return c.json({ error: 'checkpoints service unavailable' }, 503)
    const id = c.req.param('id')
    if (!agentView(app, id)) return c.json({ error: `agent ${id} not found` }, 404)
    const body = await readJson(c)
    const label = str(body, 'label')
    const checkpoint: Checkpoint = await service.snapshot(id, label || 'manual snapshot', 'manual')
    return c.json(checkpoint, 201)
  })

  api.get('/checkpoints/:id/diff', async (c) => {
    const service = checkpoints()
    if (!service) return c.json({ error: 'checkpoints service unavailable' }, 503)
    const id = c.req.param('id')
    const from = service.get(id)
    if (!from) return c.json({ error: `checkpoint ${id} not found` }, 404)
    const to = c.req.query('to')
    if (to !== undefined) {
      const target = service.get(to)
      if (!target) return c.json({ error: `checkpoint ${to} not found` }, 404)
      if (target.agentId !== from.agentId) {
        throw new TypeError('checkpoints belong to different agents')
      }
    }
    const result = await service.diff(id, to)
    return c.json(result)
  })

  api.post('/checkpoints/:id/restore', async (c) => {
    const service = checkpoints()
    if (!service) return c.json({ error: 'checkpoints service unavailable' }, 503)
    const id = c.req.param('id')
    const safety: Checkpoint = await service.restore(id, { signal: c.req.raw.signal })
    return c.json({ safety })
  })
}

function registerTeam(app: App, api: Hono): void {
  api.get('/team/proposals', (c) => {
    const proposals = app.ctx.store.collection('teamProposals').list({ order: 'desc' })
    return c.json(proposals)
  })

  api.post('/team/propose', async (c) => {
    const rooms = app.ctx.get('rooms')
    if (!rooms) return c.json({ error: 'rooms service unavailable' }, 503)
    const body = await readJson(c)
    const leadId = str(body, 'leadId')
    const goal = str(body, 'goal')
    if (leadId === undefined || goal === undefined) throw new TypeError('leadId and goal are required')
    const handle = await ensureActiveAsync(app, leadId)
    if (!handle) return c.json({ error: `agent ${leadId} not found` }, 404)
    const proposal: TeamProposal = await rooms.proposeTeam(leadId, goal)
    return c.json(proposal, 201)
  })

  api.post('/team/:id/hire', async (c) => {
    const rooms = app.ctx.get('rooms')
    if (!rooms) return c.json({ error: 'rooms service unavailable' }, 503)
    const id = c.req.param('id')
    const proposal = app.ctx.store.collection('teamProposals').get(id)
    if (!proposal) return c.json({ error: `proposal ${id} not found` }, 404)
    const handle = await ensureActiveAsync(app, proposal.leadId)
    if (!handle) return c.json({ error: `agent ${proposal.leadId} not found` }, 404)
    const hired = await rooms.hire(id, { signal: c.req.raw.signal })
    return c.json({ hired })
  })
}

function registerHealth(app: App, api: Hono): void {
  api.get('/health', (c) => {
    const active = app.ctx.agents.list().filter((h) => h.state === 'active').length
    const approvals = app.ctx.get('approvals')
    const pendingApprovals = approvals ? approvals.pending().length : 0
    return c.json({ ok: true, agents: active, pendingApprovals })
  })
}

export function createApi(app: App): Hono {
  const api = new Hono()
  api.onError((err, c) => errorResponse(c, err))
  registerAgents(app, api)
  registerRooms(app, api)
  registerApprovals(app, api)
  registerRules(app, api)
  registerSkills(app, api)
  registerRoutines(app, api)
  registerCheckpoints(app, api)
  registerTeam(app, api)
  registerHealth(app, api)
  return api
}
