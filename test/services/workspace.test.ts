import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createApp } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import { confine, makeWorkspaceTools, Workspace } from '../../src/services/workspace.ts'
import type { Tool, ToolResult } from '../../src/contracts/tools.ts'
import type { ApprovalRequest } from '../../src/contracts/approvals.ts'
import type {} from '../../src/contracts/index.ts'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

function toolByName(tools: Tool[], name: string): Tool {
  const found = tools.find((t) => t.spec.name === name)
  assert.ok(found, `tool ${name} not found`)
  return found
}

async function run(tool: Tool, input: unknown): Promise<ToolResult> {
  return tool.run(input, new AbortController().signal)
}

/** Returns true when symlinks are usable on this platform. */
function canSymlink(): boolean {
  const probe = mkTmp('whales-symprobe-')
  try {
    fs.symlinkSync(probe, path.join(probe, 'self'))
    return true
  } catch {
    return false
  } finally {
    rmrf(probe)
  }
}

const SYMLINKS_OK = canSymlink()

// ---------------------------------------------------------------------------
// confine() — pure confinement rules
// ---------------------------------------------------------------------------

test('confine: normalises simple relative paths', () => {
  const ws = mkTmp('whales-ws-')
  try {
    assert.deepEqual(confine(ws, 'a/../b'), { rel: 'b', abs: path.join(ws, 'b') })
    assert.deepEqual(confine(ws, './x/'), { rel: 'x', abs: path.join(ws, 'x') })
    assert.deepEqual(confine(ws, 'a/b/c.txt'), { rel: 'a/b/c.txt', abs: path.join(ws, 'a/b/c.txt') })
  } finally {
    rmrf(ws)
  }
})

test('confine: rejects non-string paths', () => {
  const ws = mkTmp('whales-ws-')
  try {
    assert.throws(() => confine(ws, 42), TypeError)
    assert.throws(() => confine(ws, null), TypeError)
    assert.throws(() => confine(ws, undefined), TypeError)
    assert.throws(() => confine(ws, {}), TypeError)
    assert.throws(() => confine(ws, ['a']), TypeError)
  } finally {
    rmrf(ws)
  }
})

test('confine: rejects paths longer than 1024 chars', () => {
  const ws = mkTmp('whales-ws-')
  try {
    const long = 'a'.repeat(1025)
    assert.throws(() => confine(ws, long), TypeError)
    // exactly 1024 is allowed
    const ok = 'a'.repeat(1024)
    assert.doesNotThrow(() => confine(ws, ok))
  } finally {
    rmrf(ws)
  }
})

test('confine: rejects NUL bytes', () => {
  const ws = mkTmp('whales-ws-')
  try {
    assert.throws(() => confine(ws, 'a\u0000b'), TypeError)
    assert.throws(() => confine(ws, '\u0000'), TypeError)
  } finally {
    rmrf(ws)
  }
})

test('confine: rejects absolute paths', () => {
  const ws = mkTmp('whales-ws-')
  try {
    assert.throws(() => confine(ws, '/etc/passwd'), TypeError)
    assert.throws(() => confine(ws, '/'), TypeError)
  } finally {
    rmrf(ws)
  }
})

test('confine: rejects Windows drive paths', () => {
  const ws = mkTmp('whales-ws-')
  try {
    assert.throws(() => confine(ws, 'C:\\x'), TypeError)
    assert.throws(() => confine(ws, 'C:/x'), TypeError)
    assert.throws(() => confine(ws, 'c:\\windows'), TypeError)
  } finally {
    rmrf(ws)
  }
})

test('confine: rejects escaping paths', () => {
  const ws = mkTmp('whales-ws-')
  try {
    assert.throws(() => confine(ws, '..'), TypeError)
    assert.throws(() => confine(ws, '../x'), TypeError)
    assert.throws(() => confine(ws, 'a/../../x'), TypeError)
    assert.throws(() => confine(ws, 'a\\..\\..\\x'), TypeError)
    assert.throws(() => confine(ws, '..\\x'), TypeError)
  } finally {
    rmrf(ws)
  }
})

// ---------------------------------------------------------------------------
// list_files
// ---------------------------------------------------------------------------

test('list_files: lists sorted names, folders suffixed with /', async () => {
  const ws = mkTmp('whales-ws-')
  try {
    fs.writeFileSync(path.join(ws, 'b.txt'), 'b')
    fs.writeFileSync(path.join(ws, 'a.txt'), 'a')
    fs.mkdirSync(path.join(ws, 'zdir'))
    fs.mkdirSync(path.join(ws, 'adir'))
    const tools = makeWorkspaceTools(ws)
    const res = await run(toolByName(tools, 'list_files'), {})
    assert.equal(res.isError, false)
    const lines = res.output.split('\n').filter((l) => l.length > 0)
    assert.deepEqual(lines, ['a.txt', 'adir/', 'b.txt', 'zdir/'])
  } finally {
    rmrf(ws)
  }
})

test('list_files: default path is "." and reports (empty)', async () => {
  const ws = mkTmp('whales-ws-')
  try {
    const tools = makeWorkspaceTools(ws)
    const res = await run(toolByName(tools, 'list_files'), {})
    assert.equal(res.isError, false)
    assert.equal(res.output, '(empty)')
  } finally {
    rmrf(ws)
  }
})

test('list_files: nested folders', async () => {
  const ws = mkTmp('whales-ws-')
  try {
    fs.mkdirSync(path.join(ws, 'sub', 'deep'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'sub', 'deep', 'f.txt'), 'x')
    const tools = makeWorkspaceTools(ws)
    const res = await run(toolByName(tools, 'list_files'), { path: 'sub' })
    assert.equal(res.isError, false)
    assert.deepEqual(res.output.split('\n').filter((l) => l.length > 0), ['deep/'])
  } finally {
    rmrf(ws)
  }
})

test('list_files: describe returns file.read action', () => {
  const ws = mkTmp('whales-ws-')
  try {
    const tools = makeWorkspaceTools(ws)
    const action = toolByName(tools, 'list_files').describe({ path: 'sub' })
    assert.ok(action)
    assert.equal(action.kind, 'file.read')
    assert.equal(action.target, 'sub')
    assert.equal(typeof action.summary, 'string')
  } finally {
    rmrf(ws)
  }
})

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

test('read_file: reads UTF-8 contents', async () => {
  const ws = mkTmp('whales-ws-')
  try {
    fs.writeFileSync(path.join(ws, 'hello.txt'), 'héllo wörld')
    const tools = makeWorkspaceTools(ws)
    const res = await run(toolByName(tools, 'read_file'), { path: 'hello.txt' })
    assert.equal(res.isError, false)
    assert.equal(res.output, 'héllo wörld')
  } finally {
    rmrf(ws)
  }
})

test('read_file: missing file is an error', async () => {
  const ws = mkTmp('whales-ws-')
  try {
    const tools = makeWorkspaceTools(ws)
    const res = await run(toolByName(tools, 'read_file'), { path: 'nope.txt' })
    assert.equal(res.isError, true)
  } finally {
    rmrf(ws)
  }
})

test('read_file: directory is an error', async () => {
  const ws = mkTmp('whales-ws-')
  try {
    fs.mkdirSync(path.join(ws, 'adir'))
    const tools = makeWorkspaceTools(ws)
    const res = await run(toolByName(tools, 'read_file'), { path: 'adir' })
    assert.equal(res.isError, true)
  } finally {
    rmrf(ws)
  }
})

test('read_file: 300 KiB file exceeds the 256 KiB limit', async () => {
  const ws = mkTmp('whales-ws-')
  try {
    fs.writeFileSync(path.join(ws, 'big.txt'), Buffer.alloc(300 * 1024, 0x61))
    const tools = makeWorkspaceTools(ws)
    const res = await run(toolByName(tools, 'read_file'), { path: 'big.txt' })
    assert.equal(res.isError, true)
    assert.match(res.output, /limit|256|KiB|too large/i)
  } finally {
    rmrf(ws)
  }
})

test('read_file: describe returns file.read action with rel target', () => {
  const ws = mkTmp('whales-ws-')
  try {
    const tools = makeWorkspaceTools(ws)
    const action = toolByName(tools, 'read_file').describe({ path: 'a/../b.txt' })
    assert.ok(action)
    assert.equal(action.kind, 'file.read')
    assert.equal(action.target, 'b.txt')
  } finally {
    rmrf(ws)
  }
})

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

test('write_file: writes content and reports byte count', async () => {
  const ws = mkTmp('whales-ws-')
  try {
    const tools = makeWorkspaceTools(ws)
    const res = await run(toolByName(tools, 'write_file'), { path: 'a.txt', content: 'hi' })
    assert.equal(res.isError, false)
    assert.equal(res.output, 'wrote 2 bytes to a.txt')
    assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'hi')
  } finally {
    rmrf(ws)
  }
})

test('write_file: creates parent folders', async () => {
  const ws = mkTmp('whales-ws-')
  try {
    const tools = makeWorkspaceTools(ws)
    const res = await run(toolByName(tools, 'write_file'), { path: 'a/b/c.txt', content: 'x' })
    assert.equal(res.isError, false)
    assert.equal(fs.readFileSync(path.join(ws, 'a', 'b', 'c.txt'), 'utf8'), 'x')
  } finally {
    rmrf(ws)
  }
})

test('write_file: replaces an existing file', async () => {
  const ws = mkTmp('whales-ws-')
  try {
    fs.writeFileSync(path.join(ws, 'a.txt'), 'old content')
    const tools = makeWorkspaceTools(ws)
    const res = await run(toolByName(tools, 'write_file'), { path: 'a.txt', content: 'new' })
    assert.equal(res.isError, false)
    assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'new')
  } finally {
    rmrf(ws)
  }
})

test('write_file: describe includes byte count and preview', () => {
  const ws = mkTmp('whales-ws-')
  try {
    const tools = makeWorkspaceTools(ws)
    const action = toolByName(tools, 'write_file').describe({ path: 'a.txt', content: 'hello' })
    assert.ok(action)
    assert.equal(action.kind, 'file.write')
    assert.equal(action.target, 'a.txt')
    assert.match(action.summary, /5/)
    const detail = action.detail as { preview?: string } | undefined
    assert.ok(detail)
    assert.equal(detail.preview, 'hello')
  } finally {
    rmrf(ws)
  }
})

test('write_file: describe preview is truncated to 2000 chars', () => {
  const ws = mkTmp('whales-ws-')
  try {
    const tools = makeWorkspaceTools(ws)
    const content = 'x'.repeat(5000)
    const action = toolByName(tools, 'write_file').describe({ path: 'a.txt', content })
    assert.ok(action)
    const detail = action.detail as { preview?: string } | undefined
    assert.ok(detail)
    assert.equal(detail.preview?.length, 2000)
  } finally {
    rmrf(ws)
  }
})

test('write_file: 1 MiB + 1 byte throws in describe', () => {
  const ws = mkTmp('whales-ws-')
  try {
    const tools = makeWorkspaceTools(ws)
    const content = 'x'.repeat(1024 * 1024 + 1)
    assert.throws(() => toolByName(tools, 'write_file').describe({ path: 'a.txt', content }), TypeError)
  } finally {
    rmrf(ws)
  }
})

test('write_file: no .tmp leftovers after writes', async () => {
  const ws = mkTmp('whales-ws-')
  try {
    const tools = makeWorkspaceTools(ws)
    await run(toolByName(tools, 'write_file'), { path: 'a.txt', content: 'one' })
    await run(toolByName(tools, 'write_file'), { path: 'a.txt', content: 'two' })
    await run(toolByName(tools, 'write_file'), { path: 'sub/b.txt', content: 'three' })
    const entries = fs.readdirSync(ws, { recursive: true }) as string[]
    for (const e of entries) {
      assert.ok(!e.includes('.tmp'), `unexpected tmp leftover: ${e}`)
    }
  } finally {
    rmrf(ws)
  }
})

// ---------------------------------------------------------------------------
// symlink escape (run-time refusal)
// ---------------------------------------------------------------------------

test('symlink: reading through an escaping symlink fails', { skip: !SYMLINKS_OK }, async () => {
  const ws = mkTmp('whales-ws-')
  const outside = mkTmp('whales-out-')
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret')
    fs.symlinkSync(outside, path.join(ws, 'link'))
    const tools = makeWorkspaceTools(ws)
    const res = await run(toolByName(tools, 'read_file'), { path: 'link/secret.txt' })
    assert.equal(res.isError, true)
  } finally {
    rmrf(ws)
    rmrf(outside)
  }
})

test('symlink: writing through an escaping symlink fails and creates nothing outside', { skip: !SYMLINKS_OK }, async () => {
  const ws = mkTmp('whales-ws-')
  const outside = mkTmp('whales-out-')
  try {
    fs.symlinkSync(outside, path.join(ws, 'link'))
    const tools = makeWorkspaceTools(ws)
    const res = await run(toolByName(tools, 'write_file'), { path: 'link/new.txt', content: 'x' })
    assert.equal(res.isError, true)
    assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false)
  } finally {
    rmrf(ws)
    rmrf(outside)
  }
})

test('write_file: refuses to overwrite a symlink target', { skip: !SYMLINKS_OK }, async () => {
  const ws = mkTmp('whales-ws-')
  const outside = mkTmp('whales-out-')
  try {
    fs.writeFileSync(path.join(outside, 'target.txt'), 'original')
    fs.symlinkSync(path.join(outside, 'target.txt'), path.join(ws, 'link.txt'))
    const tools = makeWorkspaceTools(ws)
    const res = await run(toolByName(tools, 'write_file'), { path: 'link.txt', content: 'overwritten' })
    assert.equal(res.isError, true)
    assert.equal(fs.readFileSync(path.join(outside, 'target.txt'), 'utf8'), 'original')
  } finally {
    rmrf(ws)
    rmrf(outside)
  }
})

// ---------------------------------------------------------------------------
// integration through the real gate
// ---------------------------------------------------------------------------

interface SpawnedAgent {
  ctx: { get(name: string): unknown }
}

async function withApp(
  fn: (app: Awaited<ReturnType<typeof createApp>>) => Promise<void>,
): Promise<void> {
  const tmp = mkTmp('whales-app-')
  const app = await createApp({
    config: defaultConfig({ env: {}, home: tmp, cwd: tmp }),
    storePath: ':memory:',
  })
  try {
    await fn(app)
  } finally {
    await app.stop()
    rmrf(tmp)
  }
}

test('integration: write_file asks for approval and deny blocks the write', async () => {
  const ws = mkTmp('whales-ws-')
  await withApp(async (app) => {
    try {
      await app.ctx.agents.spawn(
        {
          id: 'w1',
          name: 'W',
          seniority: 1,
          driver: { name: 'driver-stub' },
          plugins: [{ name: 'workspace', config: { dir: ws } }],
          permissionMode: 'ask',
        },
        { persist: false },
      )
      const handle = app.ctx.agents.get('w1')
      assert.ok(handle)
      const tools = handle.ctx.get('tools') as {
        forTurn(opts: { roomId?: string }): {
          invoke(call: { id: string; name: string; input: unknown }, signal: AbortSignal): Promise<ToolResult>
        }
      }
      const set = tools.forTurn({})

      let requested: ApprovalRequest | undefined
      app.ctx.on('whales/approval-requested', (req: ApprovalRequest) => {
        requested = req
      })

      const pending = set.invoke(
        { id: 'c1', name: 'write_file', input: { path: 'a.txt', content: 'hi' } },
        new AbortController().signal,
      )
      // wait for the approval request to appear
      for (let i = 0; i < 100 && !requested; i++) {
        await new Promise((r) => setTimeout(r, 5))
      }
      assert.ok(requested, 'expected an approval request')
      const approvals = app.ctx.get('approvals') as { answer(id: string, decision: string): boolean }
      assert.equal(approvals.answer(requested.id, 'deny'), true)
      const res = await pending
      assert.equal(res.isError, true)
      assert.match(res.output, /permission denied/i)
      assert.equal(fs.existsSync(path.join(ws, 'a.txt')), false)
    } finally {
      rmrf(ws)
    }
  })
})

test('integration: allow-once writes the file', async () => {
  const ws = mkTmp('whales-ws-')
  await withApp(async (app) => {
    try {
      await app.ctx.agents.spawn(
        {
          id: 'w1',
          name: 'W',
          seniority: 1,
          driver: { name: 'driver-stub' },
          plugins: [{ name: 'workspace', config: { dir: ws } }],
          permissionMode: 'ask',
        },
        { persist: false },
      )
      const handle = app.ctx.agents.get('w1')
      assert.ok(handle)
      const tools = handle.ctx.get('tools') as {
        forTurn(opts: { roomId?: string }): {
          invoke(call: { id: string; name: string; input: unknown }, signal: AbortSignal): Promise<ToolResult>
        }
      }
      const set = tools.forTurn({})

      let requested: ApprovalRequest | undefined
      app.ctx.on('whales/approval-requested', (req: ApprovalRequest) => {
        requested = req
      })

      const pending = set.invoke(
        { id: 'c1', name: 'write_file', input: { path: 'a.txt', content: 'hi' } },
        new AbortController().signal,
      )
      for (let i = 0; i < 100 && !requested; i++) {
        await new Promise((r) => setTimeout(r, 5))
      }
      assert.ok(requested, 'expected an approval request')
      const approvals = app.ctx.get('approvals') as { answer(id: string, decision: string): boolean }
      assert.equal(approvals.answer(requested.id, 'allow-once'), true)
      const res = await pending
      assert.equal(res.isError, false)
      assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'hi')
    } finally {
      rmrf(ws)
    }
  })
})

test('integration: allow rule skips approval for matching path only', async () => {
  const ws = mkTmp('whales-ws-')
  await withApp(async (app) => {
    try {
      await app.ctx.agents.spawn(
        {
          id: 'w1',
          name: 'W',
          seniority: 1,
          driver: { name: 'driver-stub' },
          plugins: [{ name: 'workspace', config: { dir: ws } }],
          permissionMode: 'ask',
        },
        { persist: false },
      )
      const handle = app.ctx.agents.get('w1')
      assert.ok(handle)
      const tools = handle.ctx.get('tools') as {
        forTurn(opts: { roomId?: string }): {
          invoke(call: { id: string; name: string; input: unknown }, signal: AbortSignal): Promise<ToolResult>
        }
      }
      const set = tools.forTurn({})

      const rules = app.ctx.get('rules') as { add(rule: string, scope: string): void }
      rules.add('allow writing files matching notes/**', 'agent:w1')

      let requested: ApprovalRequest | undefined
      app.ctx.on('whales/approval-requested', (req: ApprovalRequest) => {
        requested = req
      })

      // matching path: no approval request
      const ok = await set.invoke(
        { id: 'c1', name: 'write_file', input: { path: 'notes/x.md', content: 'n' } },
        new AbortController().signal,
      )
      assert.equal(ok.isError, false)
      assert.equal(requested, undefined)
      assert.equal(fs.readFileSync(path.join(ws, 'notes', 'x.md'), 'utf8'), 'n')

      // non-matching path: still asks
      const pending = set.invoke(
        { id: 'c2', name: 'write_file', input: { path: 'other.md', content: 'o' } },
        new AbortController().signal,
      )
      for (let i = 0; i < 100 && !requested; i++) {
        await new Promise((r) => setTimeout(r, 5))
      }
      assert.ok(requested, 'expected an approval request for other.md')
      const approvals = app.ctx.get('approvals') as { answer(id: string, decision: string): boolean }
      assert.equal(approvals.answer(requested.id, 'deny'), true)
      const res = await pending
      assert.equal(res.isError, true)
      assert.equal(fs.existsSync(path.join(ws, 'other.md')), false)
    } finally {
      rmrf(ws)
    }
  })
})

test('integration: deny rule blocks reads even in trusted mode', async () => {
  const ws = mkTmp('whales-ws-')
  await withApp(async (app) => {
    try {
      fs.mkdirSync(path.join(ws, 'secrets'), { recursive: true })
      fs.writeFileSync(path.join(ws, 'secrets', 'k'), 'classified')
      await app.ctx.agents.spawn(
        {
          id: 'w2',
          name: 'T',
          seniority: 1,
          driver: { name: 'driver-stub' },
          plugins: [{ name: 'workspace', config: { dir: ws } }],
          permissionMode: 'trusted',
        },
        { persist: false },
      )
      const handle = app.ctx.agents.get('w2')
      assert.ok(handle)
      const tools = handle.ctx.get('tools') as {
        forTurn(opts: { roomId?: string }): {
          invoke(call: { id: string; name: string; input: unknown }, signal: AbortSignal): Promise<ToolResult>
        }
      }
      const set = tools.forTurn({})

      const rules = app.ctx.get('rules') as { add(rule: string, scope: string): void }
      rules.add('deny reading files matching secrets/**', 'agent:w2')

      let requested: ApprovalRequest | undefined
      app.ctx.on('whales/approval-requested', (req: ApprovalRequest) => {
        requested = req
      })

      const res = await set.invoke(
        { id: 'c1', name: 'read_file', input: { path: 'secrets/k' } },
        new AbortController().signal,
      )
      assert.equal(res.isError, true)
      assert.equal(requested, undefined)
    } finally {
      rmrf(ws)
    }
  })
})

test('integration: escaping path is rejected as invalid input without approval', async () => {
  const ws = mkTmp('whales-ws-')
  const outside = mkTmp('whales-out-')
  await withApp(async (app) => {
    try {
      await app.ctx.agents.spawn(
        {
          id: 'w1',
          name: 'W',
          seniority: 1,
          driver: { name: 'driver-stub' },
          plugins: [{ name: 'workspace', config: { dir: ws } }],
          permissionMode: 'ask',
        },
        { persist: false },
      )
      const handle = app.ctx.agents.get('w1')
      assert.ok(handle)
      const tools = handle.ctx.get('tools') as {
        forTurn(opts: { roomId?: string }): {
          invoke(call: { id: string; name: string; input: unknown }, signal: AbortSignal): Promise<ToolResult>
        }
      }
      const set = tools.forTurn({})

      let requested: ApprovalRequest | undefined
      app.ctx.on('whales/approval-requested', (req: ApprovalRequest) => {
        requested = req
      })

      const res = await set.invoke(
        { id: 'c1', name: 'write_file', input: { path: '../escape.txt', content: 'x' } },
        new AbortController().signal,
      )
      assert.equal(res.isError, true)
      assert.match(res.output, /invalid input/i)
      assert.equal(requested, undefined)
      assert.equal(fs.existsSync(path.join(outside, 'escape.txt')), false)
      assert.equal(fs.existsSync(path.join(path.dirname(ws), 'escape.txt')), false)
    } finally {
      rmrf(ws)
      rmrf(outside)
    }
  })
})

test('integration: default dir is <dataDir>/workspaces/<agentId> and exists', async () => {
  const tmp = mkTmp('whales-app-')
  const app = await createApp({
    config: defaultConfig({ env: {}, home: tmp, cwd: tmp }),
    storePath: ':memory:',
  })
  try {
    await app.ctx.agents.spawn(
      {
        id: 'w1',
        name: 'W',
        seniority: 1,
        driver: { name: 'driver-stub' },
        plugins: [{ name: 'workspace' }],
        permissionMode: 'ask',
      },
      { persist: false },
    )
    const expected = path.join(app.ctx.config.dataDir, 'workspaces', 'w1')
    assert.equal(fs.existsSync(expected), true)
    assert.equal(fs.statSync(expected).isDirectory(), true)
  } finally {
    await app.stop()
    rmrf(tmp)
  }
})

test('Workspace plugin: exposes catalog name and inject', () => {
  assert.equal(Workspace.name, 'workspace')
  assert.ok(Array.isArray(Workspace.inject))
})
