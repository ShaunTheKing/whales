import { Service, type Context } from 'cordis'
import { newId, isAgentId } from '../core/ids.ts'
import type {
  RoomsService,
  Room,
  RoomEvent,
  RoomMessage,
  RoomNote,
  TeamProposal,
} from '../contracts/rooms.ts'
import type { AgentId, RoomId, TurnId } from '../contracts/core.ts'
import type { ChatMessage, DriverEvent } from '../contracts/driver.ts'
import type { AgentHandle } from '../contracts/agents.ts'
import type { Collection } from '../contracts/store.ts'
import type {} from '../contracts/approvals.ts'
import type {} from '../contracts/config.ts'

export interface RoomsConfig {
  historyLimit?: number
}

export const ARBITER_INSTRUCTION =
  'You speak last as the most senior member. Weigh the replies above, resolve any disagreement explicitly, and state the room\'s conclusion.'

const DEFAULT_HISTORY_LIMIT = 40
const MAX_MEMBERS = 12
const MAX_CONTENT = 8000
const MAX_NOTE = 1000
const MAX_GOAL = 2000

interface Hire {
  name: string
  role: string
  rationale: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return s.length > 0 ? s : 'hire'
}

export function parseTeamJson(text: string): Hire[] {
  let body = text
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fence && fence[1] !== undefined) {
    body = fence[1]
  }
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end < start) {
    throw new Error('invalid team proposal: no JSON object found')
  }
  const slice = body.slice(start, end + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch (err) {
    throw new Error(`invalid team proposal: ${err instanceof Error ? err.message : 'parse error'}`)
  }
  if (!isRecord(parsed)) {
    throw new Error('invalid team proposal: not an object')
  }
  const hires = parsed['hires']
  if (!Array.isArray(hires)) {
    throw new Error('invalid team proposal: missing hires array')
  }
  if (hires.length < 1 || hires.length > 3) {
    throw new Error('invalid team proposal: hires must have 1 to 3 entries')
  }
  const out: Hire[] = []
  for (const raw of hires) {
    if (!isRecord(raw)) {
      throw new Error('invalid team proposal: hire is not an object')
    }
    const name = typeof raw['name'] === 'string' ? raw['name'].trim() : ''
    const role = typeof raw['role'] === 'string' ? raw['role'].trim() : ''
    const rationale = typeof raw['rationale'] === 'string' ? raw['rationale'].trim() : ''
    if (name.length < 1 || name.length > 40) {
      throw new Error('invalid team proposal: name must be 1 to 40 chars')
    }
    if (role.length < 1 || role.length > 200) {
      throw new Error('invalid team proposal: role must be 1 to 200 chars')
    }
    if (rationale.length > 500) {
      throw new Error('invalid team proposal: rationale must be at most 500 chars')
    }
    out.push({ name, role, rationale })
  }
  return out
}

export class Rooms extends Service implements RoomsService {
  static inject = ['store', 'agents']

  private store: Context['store']
  private agents: Context['agents']
  private own: Context
  private historyLimit: number
  private tails = new Map<string, Promise<void>>()

  constructor(ctx: Context, config?: RoomsConfig) {
    super(ctx, 'rooms')
    this.store = ctx.store
    this.agents = ctx.agents
    this.own = ctx
    const limit = config?.historyLimit ?? DEFAULT_HISTORY_LIMIT
    this.historyLimit = Number.isInteger(limit) && limit >= 1 && limit <= 500 ? limit : DEFAULT_HISTORY_LIMIT
  }

  private rooms(): Collection<Room> {
    return this.store.collection('rooms')
  }

  private messages(): Collection<RoomMessage> {
    return this.store.collection('roomMessages')
  }

  private notesCol(): Collection<RoomNote> {
    return this.store.collection('roomNotes')
  }

  private proposals(): Collection<TeamProposal> {
    return this.store.collection('teamProposals')
  }

  private emit(roomId: RoomId, event: RoomEvent): RoomEvent {
    this.own.emit('whales/room-event', roomId, event)
    return event
  }

  private requireRoom(id: RoomId): Room {
    const room = this.rooms().get(id)
    if (!room) throw new Error(`room ${id} not found`)
    return room
  }

  private knownAgent(id: AgentId): boolean {
    if (this.agents.get(id)) return true
    return this.store.collection('agents').get(id) !== undefined
  }

  private validateMembers(members: AgentId[]): AgentId[] {
    if (!Array.isArray(members) || members.length === 0) {
      throw new TypeError('members must be a non-empty array')
    }
    if (members.length > MAX_MEMBERS) {
      throw new TypeError(`members must have at most ${MAX_MEMBERS} entries`)
    }
    const seen = new Set<string>()
    for (const m of members) {
      if (!isAgentId(m)) throw new TypeError(`invalid agent id ${JSON.stringify(m)}`)
      if (seen.has(m)) throw new TypeError(`duplicate member ${m}`)
      seen.add(m)
      if (!this.knownAgent(m)) throw new Error(`unknown agent ${m}`)
    }
    return [...members]
  }

  private displayName(id: AgentId): string {
    const handle = this.agents.get(id)
    if (handle) return handle.spec.name
    const record = this.store.collection('agents').get(id)
    if (record) return record.spec.name
    return id
  }

  private seniorityOf(id: AgentId): number {
    const handle = this.agents.get(id)
    if (handle) return handle.spec.seniority
    const record = this.store.collection('agents').get(id)
    if (record) return record.spec.seniority
    return 0
  }

  create(input: { name: string; members: AgentId[] }): Room {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (name.length < 1 || name.length > 64) {
      throw new TypeError('room name must be 1 to 64 characters')
    }
    const members = this.validateMembers(input.members)
    const room: Room = {
      id: newId('room'),
      scope: 'global',
      createdAt: Date.now(),
      name,
      members,
    }
    return this.rooms().put(room)
  }

  get(id: RoomId): Room | undefined {
    return this.rooms().get(id)
  }

  list(): Room[] {
    return this.rooms().list({ order: 'asc' })
  }

  delete(id: RoomId): boolean {
    const removed = this.rooms().delete(id)
    if (!removed) return false
    const scope = `room:${id}` as const
    this.messages().clear(scope)
    this.notesCol().clear(scope)
    return true
  }

  addMember(id: RoomId, agentId: AgentId): Room {
    const room = this.requireRoom(id)
    if (!isAgentId(agentId)) throw new TypeError(`invalid agent id ${JSON.stringify(agentId)}`)
    if (room.members.includes(agentId)) throw new Error(`agent ${agentId} is already a member`)
    if (room.members.length >= MAX_MEMBERS) {
      throw new Error(`room ${id} already has ${MAX_MEMBERS} members`)
    }
    if (!this.knownAgent(agentId)) throw new Error(`unknown agent ${agentId}`)
    const updated: Room = { ...room, members: [...room.members, agentId] }
    return this.rooms().put(updated)
  }

  removeMember(id: RoomId, agentId: AgentId): Room {
    const room = this.requireRoom(id)
    if (!room.members.includes(agentId)) throw new Error(`agent ${agentId} is not a member of room ${id}`)
    if (room.members.length <= 1) throw new Error(`cannot remove the last member of room ${id}`)
    const updated: Room = { ...room, members: room.members.filter((m) => m !== agentId) }
    return this.rooms().put(updated)
  }

  order(id: RoomId): AgentId[] {
    const room = this.requireRoom(id)
    const indexed = room.members.map((m, i) => ({ m, i, s: this.seniorityOf(m) }))
    indexed.sort((a, b) => (a.s === b.s ? a.i - b.i : a.s - b.s))
    return indexed.map((e) => e.m)
  }

  history(id: RoomId, limit = 100): RoomMessage[] {
    const scope = `room:${id}` as const
    const all = this.messages().list({ scope, order: 'asc' })
    if (limit >= all.length) return all
    return all.slice(all.length - limit)
  }

  addNote(id: RoomId, author: AgentId | 'user', text: string): RoomNote {
    const room = this.requireRoom(id)
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (trimmed.length < 1 || trimmed.length > MAX_NOTE) {
      throw new TypeError(`note text must be 1 to ${MAX_NOTE} characters`)
    }
    if (author !== 'user' && !room.members.includes(author)) {
      throw new Error(`author ${author} is not a member of room ${id}`)
    }
    const note: RoomNote = {
      id: newId('note'),
      scope: `room:${id}`,
      createdAt: Date.now(),
      author,
      text: trimmed,
    }
    return this.notesCol().put(note)
  }

  notes(id: RoomId): RoomNote[] {
    const scope = `room:${id}` as const
    return this.notesCol().list({ scope, order: 'asc' })
  }

  private buildPrompt(room: Room, member: AgentId, arbiter: boolean, notes: RoomNote[], content: string): string {
    const names = this.order(room.id).map((m) => this.displayName(m))
    const blocks: string[] = []
    blocks.push(
      `[Room "${room.name}"] Members, in speaking order: ${names.join(', ')}. You are ${this.displayName(member)}.`,
    )
    if (notes.length > 0) {
      blocks.push(`Shared room notes:\n${notes.map((n) => `- ${n.text}`).join('\n')}`)
    }
    blocks.push(
      arbiter
        ? ARBITER_INSTRUCTION
        : 'It is your turn. Reply to the latest message from the user, taking the earlier replies in this round into account. Be concise.',
    )
    blocks.push(`Latest message from the user:\n${content}`)
    return blocks.join('\n\n')
  }

  private toChatMessages(room: Room, member: AgentId, messages: RoomMessage[]): ChatMessage[] {
    return messages.map((m) => {
      if (m.speaker === member) {
        return { role: 'assistant', content: m.content }
      }
      const name = m.speaker === 'user' ? 'user' : this.displayName(m.speaker)
      return { role: 'user', content: m.content, name }
    })
  }

  async *post(id: RoomId, content: string, opts?: { signal?: AbortSignal }): AsyncIterable<RoomEvent> {
    const trimmed = typeof content === 'string' ? content.trim() : ''
    if (trimmed.length < 1 || trimmed.length > MAX_CONTENT) {
      throw new TypeError(`content must be 1 to ${MAX_CONTENT} characters`)
    }
    const room = this.requireRoom(id)

    const previous = this.tails.get(id) ?? Promise.resolve()
    let release: () => void = () => {}
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tails.set(id, previous.then(() => current))
    await previous

    try {
      const signal = opts?.signal
      const scope = `room:${id}` as const
      const existing = this.messages().list({ scope, order: 'asc' })
      let maxRound = 0
      for (const m of existing) {
        if (m.round > maxRound) maxRound = m.round
      }
      const round = maxRound + 1

      const userMessage: RoomMessage = {
        id: newId('rmsg'),
        scope,
        createdAt: Date.now(),
        speaker: 'user',
        content: trimmed,
        turnId: newId('turn'),
        round,
      }
      this.messages().put(userMessage)

      const order = this.order(id)
      yield this.emit(id, { type: 'round-start', round, order })

      for (let position = 0; position < order.length; position++) {
        const member = order[position]
        if (member === undefined) continue
        const arbiter = position === order.length - 1

        const handle: AgentHandle | undefined = this.agents.get(member)
        if (!handle || handle.state !== 'active' || !handle.runtime) {
          yield this.emit(id, { type: 'skipped', agentId: member, reason: 'agent is not running' })
          continue
        }
        const runtime = handle.runtime

        yield this.emit(id, { type: 'speaker', agentId: member, position, arbiter })

        const all = this.messages().list({ scope, order: 'asc' })
        const recent = all.length > this.historyLimit ? all.slice(all.length - this.historyLimit) : all
        const history = this.toChatMessages(room, member, recent)
        const prompt = this.buildPrompt(room, member, arbiter, this.notes(id), trimmed)

        let text = ''
        let stopReason: string | undefined
        for await (const event of runtime.turn(prompt, { roomId: id, history, signal })) {
          yield this.emit(id, { type: 'agent', agentId: member, event })
          if (event.type === 'text') {
            text += event.delta
          } else if (event.type === 'done') {
            stopReason = event.stopReason
          }
        }

        const collected = text.trim()
        if (stopReason === 'end' && collected.length > 0) {
          const message: RoomMessage = {
            id: newId('rmsg'),
            scope,
            createdAt: Date.now(),
            speaker: member,
            content: collected,
            turnId: newId('turn'),
            round,
          }
          this.messages().put(message)
          yield this.emit(id, { type: 'message', message })
        } else {
          yield this.emit(id, {
            type: 'skipped',
            agentId: member,
            reason: `turn ended: ${stopReason ?? 'unknown'}`,
          })
        }

        if (signal?.aborted) {
          break
        }
      }

      yield this.emit(id, { type: 'round-end', round })
    } finally {
      release()
      const tail = this.tails.get(id)
      if (tail) {
        void tail.finally(() => {
          if (this.tails.get(id) === tail) this.tails.delete(id)
        })
      }
    }
  }

  async proposeTeam(leadId: AgentId, goal: string): Promise<TeamProposal> {
    const trimmed = typeof goal === 'string' ? goal.trim() : ''
    if (trimmed.length < 1 || trimmed.length > MAX_GOAL) {
      throw new TypeError(`goal must be 1 to ${MAX_GOAL} characters`)
    }
    const handle = this.agents.get(leadId)
    if (!handle || handle.state !== 'active' || !handle.runtime) {
      throw new Error(`lead agent ${leadId} is not running`)
    }
    const prompt = `Propose a small team (1 to 3 people) to help with this goal:\n${trimmed}\n\nReply with ONLY a JSON object of the form {"hires":[{"name":"...","role":"...","rationale":"..."}]}.`

    let text = ''
    for await (const event of handle.runtime.turn(prompt, { roomId: 'team-proposal', history: [] })) {
      if (event.type === 'text') text += event.delta
    }

    const hires = parseTeamJson(text)
    const proposal: TeamProposal = {
      id: newId('team'),
      scope: `agent:${leadId}`,
      createdAt: Date.now(),
      leadId,
      goal: trimmed,
      hires,
      status: 'proposed',
    }
    return this.proposals().put(proposal)
  }

  async hire(proposalId: string, opts?: { signal?: AbortSignal }): Promise<AgentId[]> {
    const proposal = this.proposals().get(proposalId)
    if (!proposal) throw new Error(`team proposal ${proposalId} not found`)
    if (proposal.status !== 'proposed') {
      throw new Error(`team proposal ${proposalId} is not proposed`)
    }
    const leadId = proposal.leadId
    const lead = this.agents.get(leadId)
    if (!lead || lead.state !== 'active' || !lead.runtime) {
      throw new Error(`lead agent ${leadId} is not running`)
    }

    const approvals = this.own.get('approvals')
    if (!approvals) throw new Error('approvals service required to hire')

    const config = this.own.get('config')
    if (!config) throw new Error('config service required to hire')
    const cheapDriver = config.defaults.cheapDriver

    const n = proposal.hires.length
    const goalHead = proposal.goal.slice(0, 80)
    const authorization = await approvals.authorize(
      {
        kind: 'agent.hire',
        target: proposal.hires.map((h) => h.name).join(', '),
        agentId: leadId,
        summary: `hire ${n} agent(s) for: ${goalHead}`,
        detail: { hires: proposal.hires, driver: cheapDriver },
      },
      { mode: 'strict', signal: opts?.signal },
    )

    if (!authorization.allowed) {
      this.proposals().put({ ...proposal, status: 'rejected' })
      throw new Error(`hire not approved: ${authorization.reason}`)
    }

    const ids: AgentId[] = []
    for (const hire of proposal.hires) {
      const base = slug(hire.name)
      let candidate = base
      let suffix = 2
      while (this.agents.get(candidate) || this.store.collection('agents').get(candidate)) {
        candidate = `${base}-${suffix}`
        suffix += 1
      }
      const spec = {
        id: candidate,
        name: hire.name,
        role: hire.role,
        seniority: lead.spec.seniority - 1,
        driver: cheapDriver,
        plugins: [{ name: 'memory' }],
        permissionMode: 'ask' as const,
        hiredBy: leadId,
        instructions: `You were hired by ${lead.spec.name} to help with: ${proposal.goal}. Your rationale: ${hire.rationale}`,
      }
      await this.agents.spawn(spec)
      ids.push(candidate)
    }

    this.proposals().put({ ...proposal, status: 'hired' })
    return ids
  }
}

export default Rooms
