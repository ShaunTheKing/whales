import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { run, USAGE } from '../../src/cli/run.ts'
import type {} from '../../src/contracts/index.ts'

interface CliResult {
  code: number
  out: string
  err: string
}

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whales-cli-'))
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

function writeSkill(tmp: string, name: string, description: string, body: string): string {
  const dir = path.join(tmp, 'skill-src')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'SKILL.md')
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`)
  return file
}

test('help: no args, help, --help print USAGE', async () => {
  const tmp = makeTmp()
  try {
    for (const args of [[], ['help'], ['--help']]) {
      const r = await cli(tmp, args)
      assert.equal(r.code, 0, `args ${JSON.stringify(args)} code`)
      assert.equal(r.out, USAGE)
      for (const word of ['agents', 'chat', 'ask', 'rules', 'skills', 'routines']) {
        assert.ok(r.out.includes(word), `USAGE contains ${word}`)
      }
    }
  } finally {
    cleanup(tmp)
  }
})

test('unknown command and unknown flag exit 2', async () => {
  const tmp = makeTmp()
  try {
    const unknown = await cli(tmp, ['frobnicate'])
    assert.equal(unknown.code, 2)
    assert.ok(unknown.err.length > 0)

    const badFlag = await cli(tmp, ['agents', 'list', '--nope'])
    assert.equal(badFlag.code, 2)
    assert.ok(badFlag.err.length > 0)
  } finally {
    cleanup(tmp)
  }
})

test('agents list empty', async () => {
  const tmp = makeTmp()
  try {
    const r = await cli(tmp, ['agents', 'list'])
    assert.equal(r.code, 0)
    assert.equal(r.out.trim(), 'no agents')
  } finally {
    cleanup(tmp)
  }
})

test('agents add stub, list, show, duplicate, invalid id', async () => {
  const tmp = makeTmp()
  try {
    const add = await cli(tmp, [
      'agents', 'add', 'bob',
      '--name', 'Bob',
      '--driver', 'stub',
      '--template', 'Bob: {prompt}',
      '--role', 'helper',
    ])
    assert.equal(add.code, 0, add.err)
    assert.equal(add.out.trim(), 'added bob')

    const list = await cli(tmp, ['agents', 'list'])
    assert.equal(list.code, 0)
    const line = list.out.split('\n').find((l) => l.startsWith('bob\t'))
    assert.ok(line, `list has bob line: ${list.out}`)
    assert.ok(line.startsWith('bob\tBob\tdriver-stub'), `line format: ${line}`)

    const show = await cli(tmp, ['agents', 'show', 'bob'])
    assert.equal(show.code, 0)
    const spec = JSON.parse(show.out) as { id: string; driver: { name: string } }
    assert.equal(spec.id, 'bob')
    assert.equal(spec.driver.name, 'driver-stub')

    const dup = await cli(tmp, [
      'agents', 'add', 'bob',
      '--name', 'Bob2',
      '--driver', 'stub',
    ])
    assert.equal(dup.code, 1)
    assert.ok(dup.err.includes('already exists'), dup.err)

    const bad = await cli(tmp, [
      'agents', 'add', 'Bad Id',
      '--name', 'Bad',
      '--driver', 'stub',
    ])
    assert.equal(bad.code, 1)

    const list2 = await cli(tmp, ['agents', 'list'])
    assert.ok(!list2.out.includes('Bad Id'), list2.out)
  } finally {
    cleanup(tmp)
  }
})

test('agents add openai without model fails and persists nothing', async () => {
  const tmp = makeTmp()
  try {
    const r = await cli(tmp, [
      'agents', 'add', 'oa',
      '--name', 'OA',
      '--driver', 'openai',
      '--preset', 'deepseek',
    ])
    assert.ok(r.code === 1 || r.code === 2, `code ${r.code}`)
    const list = await cli(tmp, ['agents', 'list'])
    assert.equal(list.out.trim(), 'no agents')
  } finally {
    cleanup(tmp)
  }
})

test('agents add openai with missing api key env fails and persists nothing', async () => {
  const tmp = makeTmp()
  try {
    const r = await cli(tmp, [
      'agents', 'add', 'oa',
      '--name', 'OA',
      '--driver', 'openai',
      '--preset', 'deepseek',
      '--model', 'm',
      '--api-key-env', 'MISSING_KEY_FOR_TEST',
    ])
    assert.equal(r.code, 1, r.err)
    assert.ok(r.err.includes('MISSING_KEY_FOR_TEST'), r.err)
    const list = await cli(tmp, ['agents', 'list'])
    assert.equal(list.out.trim(), 'no agents')
  } finally {
    cleanup(tmp)
  }
})

test('agents add with invalid rule fails and persists nothing', async () => {
  const tmp = makeTmp()
  try {
    const r = await cli(tmp, [
      'agents', 'add', 'badrule',
      '--name', 'BadRule',
      '--driver', 'stub',
      '--rule', 'not a rule',
    ])
    assert.equal(r.code, 1, r.err)
    const list = await cli(tmp, ['agents', 'list'])
    assert.equal(list.out.trim(), 'no agents')
  } finally {
    cleanup(tmp)
  }
})

test('agents remove and remove unknown', async () => {
  const tmp = makeTmp()
  try {
    await cli(tmp, ['agents', 'add', 'bob', '--name', 'Bob', '--driver', 'stub'])
    const rm = await cli(tmp, ['agents', 'remove', 'bob'])
    assert.equal(rm.code, 0)
    assert.equal(rm.out.trim(), 'removed bob')

    const rm2 = await cli(tmp, ['agents', 'remove', 'bob'])
    assert.equal(rm2.code, 1)
  } finally {
    cleanup(tmp)
  }
})

test('ask streams reply and reports stop reason', async () => {
  const tmp = makeTmp()
  try {
    await cli(tmp, [
      'agents', 'add', 'bob',
      '--name', 'Bob',
      '--driver', 'stub',
      '--template', 'Bob: {prompt}',
    ])
    const r = await cli(tmp, ['ask', 'bob', 'hello', 'world'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, 'Bob: hello world\n')
    assert.ok(r.err.includes('[end'), r.err)
  } finally {
    cleanup(tmp)
  }
})

test('ask unknown agent exits 1', async () => {
  const tmp = makeTmp()
  try {
    const r = await cli(tmp, ['ask', 'nobody', 'hi'])
    assert.equal(r.code, 1)
  } finally {
    cleanup(tmp)
  }
})

test('chat REPL handles lines and /exit', async () => {
  const tmp = makeTmp()
  try {
    await cli(tmp, [
      'agents', 'add', 'bob',
      '--name', 'Bob',
      '--driver', 'stub',
      '--template', 'Bob: {prompt}',
    ])
    const r = await cli(tmp, ['chat', 'bob'], 'hi\n\n/exit\nignored\n')
    assert.equal(r.code, 0, r.err)
    const count = r.out.split('Bob: hi').length - 1
    assert.equal(count, 1, r.out)
    assert.ok(!r.out.includes('ignored'), r.out)
    assert.ok(r.err.includes('chatting with Bob'), r.err)
  } finally {
    cleanup(tmp)
  }
})

test('chat EOF without /exit runs remaining turns', async () => {
  const tmp = makeTmp()
  try {
    await cli(tmp, [
      'agents', 'add', 'bob',
      '--name', 'Bob',
      '--driver', 'stub',
      '--template', 'Bob: {prompt}',
    ])
    const r = await cli(tmp, ['chat', 'bob'], 'one\ntwo\n')
    assert.equal(r.code, 0, r.err)
    assert.ok(r.out.includes('Bob: one'), r.out)
    assert.ok(r.out.includes('Bob: two'), r.out)
  } finally {
    cleanup(tmp)
  }
})

test('sqlite file is created in the data dir', async () => {
  const tmp = makeTmp()
  try {
    await cli(tmp, [
      'agents', 'add', 'bob',
      '--name', 'Bob',
      '--driver', 'stub',
      '--template', 'Bob: {prompt}',
    ])
    await cli(tmp, ['ask', 'bob', 'first'])
    const db = path.join(tmp, 'data', 'whales.db')
    assert.ok(fs.existsSync(db), `db exists at ${db}`)
  } finally {
    cleanup(tmp)
  }
})

test('agents add with memory plugin', async () => {
  const tmp = makeTmp()
  try {
    const add = await cli(tmp, [
      'agents', 'add', 'mem',
      '--name', 'Mem',
      '--driver', 'stub',
      '--memory',
    ])
    assert.equal(add.code, 0, add.err)
    const show = await cli(tmp, ['agents', 'show', 'mem'])
    assert.equal(show.code, 0)
    const spec = JSON.parse(show.out) as { plugins: { name: string }[] }
    assert.ok(spec.plugins.some((p) => p.name === 'memory'), show.out)
  } finally {
    cleanup(tmp)
  }
})

test('rules list empty, add global, add agent-scoped, invalid, remove', async () => {
  const tmp = makeTmp()
  try {
    const empty = await cli(tmp, ['rules', 'list'])
    assert.equal(empty.code, 0)
    assert.equal(empty.out.trim(), 'no rules')

    const add = await cli(tmp, ['rules', 'add', 'deny running commands matching rm *'])
    assert.equal(add.code, 0, add.err)
    const added = add.out.trim()
    assert.ok(added.startsWith('added rule_'), added)
    const ruleId = added.slice('added '.length)

    const list = await cli(tmp, ['rules', 'list'])
    assert.equal(list.code, 0)
    const line = list.out.split('\n').find((l) => l.includes('deny running commands matching rm *'))
    assert.ok(line, list.out)
    assert.ok(line.includes('\tglobal\t'), line)

    await cli(tmp, [
      'agents', 'add', 'bob',
      '--name', 'Bob',
      '--driver', 'stub',
    ])
    const addAgent = await cli(tmp, ['rules', 'add', 'allow reading files', '--agent', 'bob'])
    assert.equal(addAgent.code, 0, addAgent.err)
    const listAgent = await cli(tmp, ['rules', 'list', '--agent', 'bob'])
    assert.equal(listAgent.code, 0)
    const agentLine = listAgent.out.split('\n').find((l) => l.includes('allow reading files'))
    assert.ok(agentLine, listAgent.out)
    assert.ok(agentLine.includes('\tagent:bob\t'), agentLine)

    const bad = await cli(tmp, ['rules', 'add', 'gibberish'])
    assert.equal(bad.code, 1)

    const rm = await cli(tmp, ['rules', 'remove', ruleId])
    assert.equal(rm.code, 0)
    assert.equal(rm.out.trim(), `removed ${ruleId}`)
  } finally {
    cleanup(tmp)
  }
})

test('skills preview, install cancelled, install yes, list, remove', async () => {
  const tmp = makeTmp()
  try {
    const file = writeSkill(tmp, 'greet', 'Says hi', 'Be friendly.')

    const preview = await cli(tmp, ['skills', 'preview', file])
    assert.equal(preview.code, 0, preview.err)
    assert.ok(preview.out.includes('name: greet'), preview.out)
    assert.ok(preview.out.includes('description: Says hi'), preview.out)
    const hashLine = preview.out.split('\n').find((l) => l.startsWith('sha256: '))
    assert.ok(hashLine, preview.out)
    const hash = hashLine.slice('sha256: '.length).trim()
    assert.match(hash, /^[0-9a-f]{64}$/)

    const cancelled = await cli(tmp, ['skills', 'install', file], 'n\n')
    assert.equal(cancelled.code, 1)
    assert.ok(cancelled.out.includes('cancelled'), cancelled.out)
    const listEmpty = await cli(tmp, ['skills', 'list'])
    assert.equal(listEmpty.out.trim(), 'no skills')

    const installed = await cli(tmp, ['skills', 'install', file], 'y\n')
    assert.equal(installed.code, 0, installed.err)
    assert.ok(installed.out.includes('installed greet'), installed.out)

    const list = await cli(tmp, ['skills', 'list'])
    assert.equal(list.code, 0)
    const line = list.out.split('\n').find((l) => l.startsWith('greet\t'))
    assert.ok(line, list.out)
    assert.ok(line.includes('Says hi'), line)

    const rm = await cli(tmp, ['skills', 'remove', 'greet'])
    assert.equal(rm.code, 0)
    assert.equal(rm.out.trim(), 'removed greet')
  } finally {
    cleanup(tmp)
  }
})

test('skills install --yes installs without stdin', async () => {
  const tmp = makeTmp()
  try {
    const file = writeSkill(tmp, 'greet', 'Says hi', 'Be friendly.')
    const r = await cli(tmp, ['skills', 'install', file, '--yes'])
    assert.equal(r.code, 0, r.err)
    assert.ok(r.out.includes('installed greet'), r.out)
    const list = await cli(tmp, ['skills', 'list'])
    assert.ok(list.out.includes('greet'), list.out)
  } finally {
    cleanup(tmp)
  }
})

test('skills preview relative path exits 1', async () => {
  const tmp = makeTmp()
  try {
    const r = await cli(tmp, ['skills', 'preview', 'SKILL.md'])
    assert.equal(r.code, 1)
  } finally {
    cleanup(tmp)
  }
})

test('agent with installed skill can run a turn', async () => {
  const tmp = makeTmp()
  try {
    const file = writeSkill(tmp, 'greet', 'Says hi', 'Be friendly.')
    await cli(tmp, ['skills', 'install', file, '--yes'])
    const add = await cli(tmp, [
      'agents', 'add', 'bob',
      '--name', 'Bob',
      '--driver', 'stub',
      '--template', 'Bob: {prompt}',
      '--skill', 'greet',
    ])
    assert.equal(add.code, 0, add.err)
    const ask = await cli(tmp, ['ask', 'bob', 'hi'])
    assert.equal(ask.code, 0, ask.err)
  } finally {
    cleanup(tmp)
  }
})

test('routines add unknown agent, add, list, bad every, run, remove', async () => {
  const tmp = makeTmp()
  try {
    const unknown = await cli(tmp, [
      'routines', 'add', 'nobody',
      '--every', '5',
      '--prompt', 'status?',
    ])
    assert.equal(unknown.code, 1)

    await cli(tmp, [
      'agents', 'add', 'bob',
      '--name', 'Bob',
      '--driver', 'stub',
      '--template', 'Bob: {prompt}',
    ])

    const add = await cli(tmp, [
      'routines', 'add', 'bob',
      '--every', '5',
      '--prompt', 'status?',
      '--quiet',
    ])
    assert.equal(add.code, 0, add.err)
    const added = add.out.trim()
    assert.ok(added.startsWith('added rtn_'), added)
    const routineId = added.slice('added '.length)

    const list = await cli(tmp, ['routines', 'list'])
    assert.equal(list.code, 0)
    const line = list.out.split('\n').find((l) => l.startsWith(routineId))
    assert.ok(line, list.out)
    assert.ok(line.includes('every 5m'), line)
    assert.ok(line.includes('enabled'), line)

    const bad = await cli(tmp, [
      'routines', 'add', 'bob',
      '--every', '3',
      '--prompt', 'x',
    ])
    assert.equal(bad.code, 1)

    const runNow = await cli(tmp, ['routines', 'run', routineId])
    assert.equal(runNow.code, 0, runNow.err)
    assert.ok(runNow.out.includes('Bob: status?'), runNow.out)

    const rm = await cli(tmp, ['routines', 'remove', routineId])
    assert.equal(rm.code, 0)
    assert.equal(rm.out.trim(), `removed ${routineId}`)
  } finally {
    cleanup(tmp)
  }
})

test('approvals empty', async () => {
  const tmp = makeTmp()
  try {
    const r = await cli(tmp, ['approvals'])
    assert.equal(r.code, 0)
    assert.equal(r.out.trim(), 'no approvals')
  } finally {
    cleanup(tmp)
  }
})

test('rules list --agent shows rules from the agent spec', async () => {
  const tmp = makeTmp()
  try {
    const add = await cli(tmp, ['agents', 'add', 'sam', '--name', 'Sam', '--driver', 'stub', '--rule', 'deny running commands matching rm *'])
    assert.equal(add.code, 0, add.err)
    const listed = await cli(tmp, ['rules', 'list', '--agent', 'sam'])
    assert.equal(listed.code, 0)
    assert.ok(listed.out.includes('(spec)\tagent:sam\tdeny running commands matching rm *'), listed.out)
  } finally {
    cleanup(tmp)
  }
})
