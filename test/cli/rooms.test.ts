import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { run } from '../../src/cli/run.ts'
import type {} from '../../src/contracts/index.ts'

interface CliResult {
  code: number
  out: string
  err: string
}

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whales-cli-rooms-'))
}

function cleanup(tmp: string): void {
  fs.rmSync(tmp, { recursive: true, force: true })
}

async function cli(tmp: string, args: string[], input = ''): Promise<CliResult> {
  let out = ''
  let err = ''
  const code = await run(args, {
    stdout: { write(s: string) { out += s; return true } },
    stderr: { write(s: string) { err += s; return true } },
    stdin: Readable.from([input]),
    env: { WHALES_DATA_DIR: path.join(tmp, 'data') },
    cwd: tmp,
  })
  return { code, out, err }
}

/** Writes a config that makes the cheap driver a stub, so hires need no API key. */
function writeCheapDriverConfig(tmp: string): void {
  const dataDir = path.join(tmp, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(
    path.join(dataDir, 'whales.config.json'),
    JSON.stringify({ defaults: { cheapDriver: { name: 'driver-stub', config: { template: 'hired' } } } }),
  )
}

async function addStub(
  tmp: string,
  id: string,
  name: string,
  seniority: number,
  template: string,
): Promise<void> {
  const r = await cli(tmp, [
    'agents', 'add', id,
    '--name', name,
    '--driver', 'stub',
    '--seniority', String(seniority),
    '--template', template,
  ])
  assert.equal(r.code, 0, r.err)
}

/** Adds the three standard room members: Ann (1), Bob (2), Cy (10). */
async function addRoomMembers(tmp: string): Promise<void> {
  await addStub(tmp, 'ann', 'Ann', 1, 'Ann: tabs')
  await addStub(tmp, 'bob', 'Bob', 2, 'Bob: spaces')
  await addStub(tmp, 'cy', 'Cy', 10, 'Cy decides: spaces')
}

function roomIdFrom(out: string): string {
  const line = out.trim()
  assert.ok(line.startsWith('created room_'), line)
  return line.slice('created '.length)
}

test('rooms list empty and create usage errors', async () => {
  const tmp = makeTmp()
  try {
    const empty = await cli(tmp, ['rooms', 'list'])
    assert.equal(empty.code, 0, empty.err)
    assert.equal(empty.out.trim(), 'no rooms')

    const noMembers = await cli(tmp, ['rooms', 'create', 'Style'])
    assert.equal(noMembers.code, 2, noMembers.err)

    await addRoomMembers(tmp)
    const unknown = await cli(tmp, ['rooms', 'create', 'Style', '--members', 'cy,ann,nobody'])
    assert.equal(unknown.code, 1, unknown.err)
  } finally {
    cleanup(tmp)
  }
})

test('rooms create, list, post, history, note, members, delete', async () => {
  const tmp = makeTmp()
  try {
    await addRoomMembers(tmp)

    const created = await cli(tmp, ['rooms', 'create', 'Style', '--members', 'cy,ann,bob'])
    assert.equal(created.code, 0, created.err)
    const roomId = roomIdFrom(created.out)

    const list = await cli(tmp, ['rooms', 'list'])
    assert.equal(list.code, 0, list.err)
    const line = list.out.split('\n').find((l) => l.startsWith(roomId))
    assert.ok(line, list.out)
    assert.ok(line.includes('Style'), line)
    assert.ok(line.includes('cy,ann,bob'), line)

    const post = await cli(tmp, ['rooms', 'post', roomId, 'Tabs', 'or', 'spaces?'])
    assert.equal(post.code, 0, post.err)
    const annIdx = post.out.indexOf('── Ann ──')
    const bobIdx = post.out.indexOf('── Bob ──')
    const cyIdx = post.out.indexOf('── Cy (arbiter) ──')
    assert.ok(annIdx >= 0, post.out)
    assert.ok(bobIdx > annIdx, post.out)
    assert.ok(cyIdx > bobIdx, post.out)
    const annReply = post.out.indexOf('Ann: tabs')
    const bobReply = post.out.indexOf('Bob: spaces')
    const cyReply = post.out.indexOf('Cy decides: spaces')
    assert.ok(annReply >= 0, post.out)
    assert.ok(bobReply > annReply, post.out)
    assert.ok(cyReply > bobReply, post.out)

    const history = await cli(tmp, ['rooms', 'history', roomId])
    assert.equal(history.code, 0, history.err)
    const lines = history.out.split('\n').filter((l) => l.length > 0)
    assert.ok(lines[0]?.startsWith('[1] you: Tabs or spaces?'), history.out)
    const agentLines = lines.filter((l) => l.includes('Ann: tabs') || l.includes('Bob: spaces') || l.includes('Cy decides: spaces'))
    assert.equal(agentLines.length, 3, history.out)

    const note = await cli(tmp, ['rooms', 'note', roomId, 'remember', 'the', 'style', 'guide'])
    assert.equal(note.code, 0, note.err)
    assert.ok(note.out.trim().startsWith('noted note_'), note.out)

    const removed = await cli(tmp, ['rooms', 'members', roomId, 'remove', 'bob'])
    assert.equal(removed.code, 0, removed.err)
    assert.equal(removed.out.trim(), 'ok')

    const post2 = await cli(tmp, ['rooms', 'post', roomId, 'again'])
    assert.equal(post2.code, 0, post2.err)
    assert.ok(!post2.out.includes('── Bob ──'), post2.out)

    const deleted = await cli(tmp, ['rooms', 'delete', roomId])
    assert.equal(deleted.code, 0, deleted.err)
    assert.equal(deleted.out.trim(), `deleted ${roomId}`)

    const list2 = await cli(tmp, ['rooms', 'list'])
    assert.equal(list2.code, 0, list2.err)
    assert.equal(list2.out.trim(), 'no rooms')

    const deleted2 = await cli(tmp, ['rooms', 'delete', roomId])
    assert.equal(deleted2.code, 1, deleted2.err)
  } finally {
    cleanup(tmp)
  }
})

test('rooms unknown subcommand exits 2', async () => {
  const tmp = makeTmp()
  try {
    const r = await cli(tmp, ['rooms', 'frobnicate'])
    assert.equal(r.code, 2, r.err)
    assert.ok(r.err.length > 0)
  } finally {
    cleanup(tmp)
  }
})

test('team propose prints proposal and hires', async () => {
  const tmp = makeTmp()
  try {
    writeCheapDriverConfig(tmp)
    await addStub(tmp, 'lead', 'Lead', 5, '{"hires":[{"name":"Data Diver","role":"analyst","rationale":"numbers"}]}')

    const propose = await cli(tmp, ['team', 'propose', 'lead', 'Analyse', 'sales'])
    assert.equal(propose.code, 0, propose.err)
    const first = propose.out.split('\n')[0] ?? ''
    assert.ok(first.startsWith('proposal team_'), propose.out)
    assert.ok(propose.out.includes('- Data Diver (analyst): numbers'), propose.out)
  } finally {
    cleanup(tmp)
  }
})

test('team propose with non-JSON lead exits 1', async () => {
  const tmp = makeTmp()
  try {
    writeCheapDriverConfig(tmp)
    await addStub(tmp, 'lead', 'Lead', 5, 'not json at all')

    const propose = await cli(tmp, ['team', 'propose', 'lead', 'Analyse', 'sales'])
    assert.equal(propose.code, 1, propose.err)
  } finally {
    cleanup(tmp)
  }
})

test('team hire denied leaves no agent', async () => {
  const tmp = makeTmp()
  try {
    writeCheapDriverConfig(tmp)
    await addStub(tmp, 'lead', 'Lead', 5, '{"hires":[{"name":"Data Diver","role":"analyst","rationale":"numbers"}]}')

    const propose = await cli(tmp, ['team', 'propose', 'lead', 'Analyse', 'sales'])
    assert.equal(propose.code, 0, propose.err)
    const proposalId = (propose.out.split('\n')[0] ?? '').slice('proposal '.length)
    assert.ok(proposalId.startsWith('team_'), propose.out)

    const hire = await cli(tmp, ['team', 'hire', proposalId], 'n\n')
    assert.equal(hire.code, 1, hire.err)
    assert.ok(hire.err.includes('approval needed'), hire.err)

    const list = await cli(tmp, ['agents', 'list'])
    assert.equal(list.code, 0, list.err)
    assert.ok(!list.out.includes('data-diver'), list.out)
  } finally {
    cleanup(tmp)
  }
})

test('team hire approved creates agent with hiredBy and seniority', async () => {
  const tmp = makeTmp()
  try {
    writeCheapDriverConfig(tmp)
    await addStub(tmp, 'lead', 'Lead', 5, '{"hires":[{"name":"Data Diver","role":"analyst","rationale":"numbers"}]}')

    const propose = await cli(tmp, ['team', 'propose', 'lead', 'Analyse', 'sales'])
    assert.equal(propose.code, 0, propose.err)
    const proposalId = (propose.out.split('\n')[0] ?? '').slice('proposal '.length)
    assert.ok(proposalId.startsWith('team_'), propose.out)

    const hire = await cli(tmp, ['team', 'hire', proposalId], 'y\n')
    assert.equal(hire.code, 0, hire.err)
    assert.ok(hire.out.includes('hired data-diver'), hire.out)

    const list = await cli(tmp, ['agents', 'list'])
    assert.equal(list.code, 0, list.err)
    assert.ok(list.out.includes('data-diver'), list.out)

    const show = await cli(tmp, ['agents', 'show', 'data-diver'])
    assert.equal(show.code, 0, show.err)
    const spec = JSON.parse(show.out) as { hiredBy?: string; seniority?: number }
    assert.equal(spec.hiredBy, 'lead')
    assert.equal(spec.seniority, 4)
  } finally {
    cleanup(tmp)
  }
})

test('agents add with --workspace includes workspace plugin', async () => {
  const tmp = makeTmp()
  try {
    const add = await cli(tmp, [
      'agents', 'add', 'ws',
      '--name', 'Ws',
      '--driver', 'stub',
      '--workspace',
    ])
    assert.equal(add.code, 0, add.err)

    const show = await cli(tmp, ['agents', 'show', 'ws'])
    assert.equal(show.code, 0, show.err)
    const spec = JSON.parse(show.out) as { plugins: { name: string }[] }
    assert.ok(spec.plugins.some((p) => p.name === 'workspace'), show.out)
  } finally {
    cleanup(tmp)
  }
})
