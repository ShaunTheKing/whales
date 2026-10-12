import { parseArgs } from 'node:util'

import type { Ctx } from './run.ts'
import { usage, fail, errMessage, spawnStored } from './run.ts'
import type { AgentId, RoomId } from '../contracts/core.ts'
import type { RoomEvent } from '../contracts/rooms.ts'
import type { DriverEvent } from '../contracts/driver.ts'
import type {} from '../contracts/index.ts'

/** Truncates a string to `n` characters, replacing newlines with spaces. */
function clip(s: string, n: number): string {
  const flat = s.replace(/\n/g, ' ')
  return flat.length > n ? flat.slice(0, n) : flat
}

function splitMembers(raw: string): AgentId[] {
  return raw
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0) as AgentId[]
}

function agentName(ctx: Ctx, id: AgentId): string {
  return ctx.app.ctx.store.collection('agents').get(id)?.spec.name ?? id
}

function isActive(ctx: Ctx, id: AgentId): boolean {
  return ctx.app.ctx.agents.get(id)?.state === 'active'
}

/** Starts every member that is not already active; failures are reported and skipped. */
async function startMembers(ctx: Ctx, members: AgentId[]): Promise<void> {
  for (const member of members) {
    if (isActive(ctx, member)) continue
    try {
      await spawnStored(ctx, member)
    } catch (err) {
      ctx.io.stderr.write(`failed ${member}: ${errMessage(err)}\n`)
    }
  }
}

function handleAgentEvent(ctx: Ctx, event: DriverEvent): void {
  if (event.type === 'text') {
    ctx.io.stdout.write(event.delta)
  } else if (event.type === 'thinking') {
    // nothing
  } else if (event.type === 'tool_call') {
    ctx.io.stderr.write(`[tool ${event.name} ${clip(JSON.stringify(event.input), 200)}]\n`)
  } else if (event.type === 'tool_result') {
    const status = event.isError ? 'error' : 'ok'
    ctx.io.stderr.write(`[${status}: ${clip(event.output, 200)}]\n`)
  } else if (event.type === 'error') {
    ctx.io.stderr.write(`error: ${event.message}\n`)
  }
}

function handleRoomEvent(ctx: Ctx, event: RoomEvent): void {
  if (event.type === 'speaker') {
    const name = agentName(ctx, event.agentId)
    const suffix = event.arbiter ? ' (arbiter)' : ''
    ctx.io.stdout.write(`\n── ${name}${suffix} ──\n`)
  } else if (event.type === 'agent') {
    handleAgentEvent(ctx, event.event)
  } else if (event.type === 'message') {
    ctx.io.stdout.write('\n')
  } else if (event.type === 'skipped') {
    ctx.io.stderr.write(`(${agentName(ctx, event.agentId)} skipped: ${event.reason})\n`)
  }
}

// ---------------------------------------------------------------------------
// rooms
// ---------------------------------------------------------------------------

async function cmdRoomsCreate(ctx: Ctx, args: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { members: { type: 'string' } },
    })
  } catch (err) {
    usage(errMessage(err))
  }
  const name = parsed.positionals[0]
  if (!name) usage('rooms create: missing <name>')
  const membersRaw = parsed.values.members
  if (membersRaw === undefined) usage('rooms create: --members is required')

  const rooms = ctx.app.ctx.get('rooms')
  if (!rooms) fail('rooms service is not running')
  let room
  try {
    room = rooms.create({ name, members: splitMembers(membersRaw) })
  } catch (err) {
    fail(errMessage(err))
  }
  ctx.io.stdout.write(`created ${room.id}\n`)
  return 0
}

function cmdRoomsList(ctx: Ctx, args: string[]): number {
  try {
    parseArgs({ args, allowPositionals: false, strict: true, options: {} })
  } catch (err) {
    usage(`rooms list: ${errMessage(err)}`)
  }
  const rooms = ctx.app.ctx.get('rooms')
  if (!rooms) fail('rooms service is not running')
  const list = rooms.list()
  if (list.length === 0) {
    ctx.io.stdout.write('no rooms\n')
    return 0
  }
  for (const room of list) {
    ctx.io.stdout.write(`${room.id}\t${room.name}\t${room.members.join(',')}\n`)
  }
  return 0
}

function cmdRoomsDelete(ctx: Ctx, args: string[]): number {
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {} })
  } catch (err) {
    usage(errMessage(err))
  }
  const id = parsed.positionals[0]
  if (!id) usage('rooms delete: missing <id>')
  const rooms = ctx.app.ctx.get('rooms')
  if (!rooms) fail('rooms service is not running')
  const ok = rooms.delete(id as RoomId)
  if (!ok) fail(`unknown room ${id}`)
  ctx.io.stdout.write(`deleted ${id}\n`)
  return 0
}

function cmdRoomsMembers(ctx: Ctx, args: string[]): number {
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {} })
  } catch (err) {
    usage(errMessage(err))
  }
  const id = parsed.positionals[0]
  if (!id) usage('rooms members: missing <id>')
  const action = parsed.positionals[1]
  if (action !== 'add' && action !== 'remove') usage('rooms members: expected add|remove')
  const agentId = parsed.positionals[2]
  if (!agentId) usage('rooms members: missing <agentId>')

  const rooms = ctx.app.ctx.get('rooms')
  if (!rooms) fail('rooms service is not running')
  try {
    if (action === 'add') rooms.addMember(id as RoomId, agentId as AgentId)
    else rooms.removeMember(id as RoomId, agentId as AgentId)
  } catch (err) {
    fail(errMessage(err))
  }
  ctx.io.stdout.write('ok\n')
  return 0
}

function cmdRoomsNote(ctx: Ctx, args: string[]): number {
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {} })
  } catch (err) {
    usage(errMessage(err))
  }
  const id = parsed.positionals[0]
  if (!id) usage('rooms note: missing <id>')
  const text = parsed.positionals.slice(1).join(' ')
  if (text.length === 0) usage('rooms note: missing <text>')

  const rooms = ctx.app.ctx.get('rooms')
  if (!rooms) fail('rooms service is not running')
  let note
  try {
    note = rooms.addNote(id as RoomId, 'user', text)
  } catch (err) {
    fail(errMessage(err))
  }
  ctx.io.stdout.write(`noted ${note.id}\n`)
  return 0
}

function cmdRoomsHistory(ctx: Ctx, args: string[]): number {
  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { limit: { type: 'string' } },
    })
  } catch (err) {
    usage(errMessage(err))
  }
  const id = parsed.positionals[0]
  if (!id) usage('rooms history: missing <id>')
  let limit: number | undefined
  const limitRaw = parsed.values.limit
  if (limitRaw !== undefined) {
    const n = Number(limitRaw)
    if (!Number.isInteger(n)) usage('rooms history: --limit must be an integer')
    limit = n
  }

  const rooms = ctx.app.ctx.get('rooms')
  if (!rooms) fail('rooms service is not running')
  const messages = rooms.history(id as RoomId, limit)
  if (messages.length === 0) {
    ctx.io.stdout.write('no messages\n')
    return 0
  }
  for (const message of messages) {
    const speaker = message.speaker === 'user' ? 'you' : agentName(ctx, message.speaker)
    ctx.io.stdout.write(`[${message.round}] ${speaker}: ${message.content}\n`)
  }
  return 0
}

async function cmdRoomsPost(ctx: Ctx, args: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {} })
  } catch (err) {
    usage(errMessage(err))
  }
  const id = parsed.positionals[0]
  if (!id) usage('rooms post: missing <id>')
  const message = parsed.positionals.slice(1).join(' ')
  if (message.length === 0) usage('rooms post: missing <message>')

  const rooms = ctx.app.ctx.get('rooms')
  if (!rooms) fail('rooms service is not running')
  const room = rooms.get(id as RoomId)
  if (!room) fail(`unknown room ${id}`)

  await startMembers(ctx, room.members)

  for await (const event of rooms.post(id as RoomId, message)) {
    handleRoomEvent(ctx, event)
  }
  return 0
}

async function cmdRooms(ctx: Ctx, args: string[]): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  if (sub === 'create') return cmdRoomsCreate(ctx, rest)
  if (sub === 'list') return cmdRoomsList(ctx, rest)
  if (sub === 'delete') return cmdRoomsDelete(ctx, rest)
  if (sub === 'members') return cmdRoomsMembers(ctx, rest)
  if (sub === 'note') return cmdRoomsNote(ctx, rest)
  if (sub === 'history') return cmdRoomsHistory(ctx, rest)
  if (sub === 'post') return cmdRoomsPost(ctx, rest)
  usage(`rooms: unknown subcommand ${sub ?? ''}`)
}

// ---------------------------------------------------------------------------
// team
// ---------------------------------------------------------------------------

async function cmdTeamPropose(ctx: Ctx, args: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {} })
  } catch (err) {
    usage(errMessage(err))
  }
  const leadId = parsed.positionals[0]
  if (!leadId) usage('team propose: missing <leadId>')
  const goal = parsed.positionals.slice(1).join(' ')
  if (goal.length === 0) usage('team propose: missing <goal>')

  const rooms = ctx.app.ctx.get('rooms')
  if (!rooms) fail('rooms service is not running')
  await spawnStored(ctx, leadId)
  let proposal
  try {
    proposal = await rooms.proposeTeam(leadId as AgentId, goal)
  } catch (err) {
    fail(errMessage(err))
  }
  ctx.io.stdout.write(`proposal ${proposal.id}\n`)
  for (const hire of proposal.hires) {
    ctx.io.stdout.write(`- ${hire.name} (${hire.role}): ${hire.rationale}\n`)
  }
  return 0
}

async function cmdTeamHire(ctx: Ctx, args: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {} })
  } catch (err) {
    usage(errMessage(err))
  }
  const proposalId = parsed.positionals[0]
  if (!proposalId) usage('team hire: missing <proposalId>')

  const rooms = ctx.app.ctx.get('rooms')
  if (!rooms) fail('rooms service is not running')
  const proposal = ctx.app.ctx.store.collection('teamProposals').get(proposalId)
  if (!proposal) fail(`unknown proposal ${proposalId}`)

  await spawnStored(ctx, proposal.leadId)
  let hired: AgentId[]
  try {
    hired = await rooms.hire(proposalId)
  } catch (err) {
    fail(errMessage(err))
  }
  for (const id of hired) {
    ctx.io.stdout.write(`hired ${id}\n`)
  }
  return 0
}

async function cmdTeam(ctx: Ctx, args: string[]): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  if (sub === 'propose') return cmdTeamPropose(ctx, rest)
  if (sub === 'hire') return cmdTeamHire(ctx, rest)
  usage(`team: unknown subcommand ${sub ?? ''}`)
}

export { cmdRooms, cmdTeam }
