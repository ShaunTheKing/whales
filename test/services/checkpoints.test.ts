import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, symlinkSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { createApp } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import type {} from '../../src/contracts/index.ts'
import type { Checkpoint } from '../../src/contracts/checkpoints.ts'
import type { ApprovalRequest } from '../../src/contracts/approvals.ts'

const HEX40 = /^[0-9a-f]{40}$/

interface Harness {
  app: Awaited<ReturnType<typeof createApp>>
  tmp: string
  dataDir: string
  cleanup: () => Promise<void>
}

async function makeApp(opts: { maxPatchBytes?: number } = {}): Promise<Harness> {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ckpt-test-'))
  const app = await createApp({
    config: defaultConfig({ env: {}, home: tmp, cwd: tmp }),
    storePath: ':memory:',
    services: { checkpoints: opts.maxPatchBytes === undefined ? {} : { maxPatchBytes: opts.maxPatchBytes } },
  })
  const dataDir = app.ctx.config.dataDir
  return {
    app,
    tmp,
    dataDir,
    cleanup: async () => {
      await app.stop()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

function workdir(dataDir: string, id: string): string {
  return path.join(dataDir, 'workspaces', id)
}

async function ensureAgent(h: Harness, id: string): Promise<void> {
  if (!h.app.ctx.agents.get(id)) await spawnAgent(h, id, [])
}

function ensureWorkdir(dataDir: string, id: string): string {
  const dir = workdir(dataDir, id)
  mkdirSync(dir, { recursive: true })
  return dir
}

function write(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function read(dir: string, rel: string): string {
  return readFileSync(path.join(dir, rel), 'utf8')
}

async function spawnAgent(h: Harness, id: string, plugins: { name: string; config?: Record<string, unknown> }[] = [{ name: 'checkpoints' }]) {
  return h.app.ctx.agents.spawn(
    {
      id,
      name: id,
      seniority: 1,
      driver: { name: 'driver-stub', config: { template: 'ok' } },
      plugins,
    },
    { persist: false },
  )
}

/** Auto-answer approvals with the given decision. Returns a stop function. */
function autoAnswer(h: Harness, decision: 'allow-once' | 'allow-always' | 'deny'): () => void {
  const off = h.app.ctx.on('whales/approval-requested', (req: ApprovalRequest) => {
    h.app.ctx.get('approvals')?.answer(req.id, decision)
  })
  return () => {
    off()
  }
}

function svc(h: Harness) {
  const s = h.app.ctx.get('checkpoints')
  assert.ok(s, 'checkpoints service must be installed')
  return s
}

function changesPaths(changes: { path: string }[]): string[] {
  return changes.map((c) => c.path).sort()
}

// ---------------------------------------------------------------------------
// snapshot / list
// ---------------------------------------------------------------------------

test('snapshot returns a well-formed checkpoint and list() is ordered', async () => {
  const h = await makeApp()
  try {
    const id = 'agent-a'
    await ensureAgent(h, id)
    const dir = ensureWorkdir(h.dataDir, id)
    write(dir, 'a.txt', 'one\n')
    const s = svc(h)

    const c1 = await s.snapshot(id, 'first')
    assert.match(c1.id, /^ckpt_/)
    assert.equal(c1.agentId, id)
    assert.equal(c1.phase, 'manual')
    assert.equal(c1.label, 'first')
    assert.match(c1.ref, HEX40)

    write(dir, 'a.txt', 'two\n')
    const c2 = await s.snapshot(id, 'second', 'before')
    assert.equal(c2.phase, 'before')
    assert.match(c2.ref, HEX40)
    assert.notEqual(c1.ref, c2.ref)

    const list = s.list(id)
    assert.equal(list.length, 2)
    assert.equal(list[0]?.id, c1.id)
    assert.equal(list[1]?.id, c2.id)
  } finally {
    await h.cleanup()
  }
})

test('snapshot of an unchanged tree still succeeds (allow-empty)', async () => {
  const h = await makeApp()
  try {
    const id = 'agent-empty'
    await ensureAgent(h, id)
    ensureWorkdir(h.dataDir, id)
    const s = svc(h)
    const c1 = await s.snapshot(id, 'one')
    const c2 = await s.snapshot(id, 'two')
    assert.match(c1.ref, HEX40)
    assert.match(c2.ref, HEX40)
    assert.equal(s.list(id).length, 2)
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

test('diff reports added/modified/deleted with exact paths including nested and spaced names', async () => {
  const h = await makeApp()
  try {
    const id = 'agent-diff'
    await ensureAgent(h, id)
    const dir = ensureWorkdir(h.dataDir, id)
    write(dir, 'keep.txt', 'keep\n')
    write(dir, 'mod.txt', 'before\n')
    write(dir, 'del.txt', 'gone\n')
    const s = svc(h)
    const a = await s.snapshot(id, 'a')

    write(dir, 'mod.txt', 'after\n')
    rmSync(path.join(dir, 'del.txt'))
    write(dir, 'src/x.ts', 'export const x = 1\n')
    write(dir, 'with space.txt', 'spaced\n')
    const b = await s.snapshot(id, 'b')

    const { changes, patch } = await s.diff(a.id, b.id)
    const byPath = new Map(changes.map((c) => [c.path, c.status]))
    assert.equal(byPath.get('mod.txt'), 'modified')
    assert.equal(byPath.get('del.txt'), 'deleted')
    assert.equal(byPath.get('src/x.ts'), 'added')
    assert.equal(byPath.get('with space.txt'), 'added')
    assert.equal(byPath.has('keep.txt'), false)

    assert.match(patch, /after/)
    assert.match(patch, /export const x = 1/)
  } finally {
    await h.cleanup()
  }
})

test('diff(a) against the live tree includes new untracked files', async () => {
  const h = await makeApp()
  try {
    const id = 'agent-live'
    await ensureAgent(h, id)
    const dir = ensureWorkdir(h.dataDir, id)
    write(dir, 'base.txt', 'base\n')
    const s = svc(h)
    const a = await s.snapshot(id, 'a')

    write(dir, 'untracked.txt', 'new\n')
    const { changes } = await s.diff(a.id)
    assert.ok(changesPaths(changes).includes('untracked.txt'))
  } finally {
    await h.cleanup()
  }
})

test('maxPatchBytes truncates the patch with a marker', async () => {
  const h = await makeApp({ maxPatchBytes: 200 })
  try {
    const id = 'agent-trunc'
    await ensureAgent(h, id)
    const dir = ensureWorkdir(h.dataDir, id)
    write(dir, 'big.txt', 'start\n')
    const s = svc(h)
    const a = await s.snapshot(id, 'a')

    const lines: string[] = []
    for (let i = 0; i < 500; i++) lines.push(`line-${i}-${'x'.repeat(40)}`)
    write(dir, 'big.txt', lines.join('\n') + '\n')
    const b = await s.snapshot(id, 'b')

    const { patch } = await s.diff(a.id, b.id)
    assert.ok(patch.length <= 200 + 64, `patch should be truncated, got ${patch.length}`)
    assert.match(patch, /truncated/i)
  } finally {
    await h.cleanup()
  }
})

test('diff across two agents rejects with TypeError', async () => {
  const h = await makeApp()
  try {
    const s = svc(h)
    await ensureAgent(h, 'agent-x')
    const d1 = ensureWorkdir(h.dataDir, 'agent-x')
    write(d1, 'f.txt', 'x\n')
    const c1 = await s.snapshot('agent-x', 'x')

    await ensureAgent(h, 'agent-y')

    const d2 = ensureWorkdir(h.dataDir, 'agent-y')
    write(d2, 'f.txt', 'y\n')
    const c2 = await s.snapshot('agent-y', 'y')

    await assert.rejects(() => s.diff(c1.id, c2.id), TypeError)
  } finally {
    await h.cleanup()
  }
})

test('diff with an unknown id rejects', async () => {
  const h = await makeApp()
  try {
    const s = svc(h)
    await assert.rejects(() => s.diff('ckpt_does_not_exist'))
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

test('restore denied rejects with "not approved" and leaves the workspace unchanged', async () => {
  const h = await makeApp()
  try {
    const id = 'agent-deny'
    await ensureAgent(h, id)
    const dir = ensureWorkdir(h.dataDir, id)
    write(dir, 'f.txt', 'v1\n')
    const s = svc(h)
    const a = await s.snapshot(id, 'a')
    write(dir, 'f.txt', 'v2\n')

    const stop = autoAnswer(h, 'deny')
    try {
      await assert.rejects(() => s.restore(a.id), /not approved/i)
    } finally {
      stop()
    }
    assert.equal(read(dir, 'f.txt'), 'v2\n')
  } finally {
    await h.cleanup()
  }
})

test('restore approved reverts to the exact target state and returns a safety checkpoint', async () => {
  const h = await makeApp()
  try {
    const id = 'agent-restore'
    await ensureAgent(h, id)
    const dir = ensureWorkdir(h.dataDir, id)
    write(dir, 'mod.txt', 'original\n')
    write(dir, 'del.txt', 'will-be-deleted\n')
    write(dir, 'nested/deep/keep.txt', 'nested\n')
    const s = svc(h)
    const target = await s.snapshot(id, 'target')

    // mutate: modify, delete, add
    write(dir, 'mod.txt', 'changed\n')
    rmSync(path.join(dir, 'del.txt'))
    write(dir, 'added.txt', 'added-later\n')
    write(dir, 'nested/deep/keep.txt', 'nested-changed\n')

    const stop = autoAnswer(h, 'allow-once')
    let safety: Checkpoint
    try {
      safety = await s.restore(target.id)
    } finally {
      stop()
    }

    assert.equal(safety.phase, 'manual')
    assert.equal(read(dir, 'mod.txt'), 'original\n')
    assert.equal(read(dir, 'del.txt'), 'will-be-deleted\n')
    assert.equal(read(dir, 'nested/deep/keep.txt'), 'nested\n')
    assert.equal(existsSync(path.join(dir, 'added.txt')), false)

    // safety captures the pre-restore state
    const { changes } = await s.diff(target.id, safety.id)
    const paths = changesPaths(changes)
    assert.ok(paths.includes('mod.txt'))
    assert.ok(paths.includes('added.txt'))
    assert.ok(paths.includes('del.txt'))

    // undo the restore by restoring the safety checkpoint
    const stop2 = autoAnswer(h, 'allow-once')
    try {
      await s.restore(safety.id)
    } finally {
      stop2()
    }
    assert.equal(read(dir, 'mod.txt'), 'changed\n')
    assert.equal(read(dir, 'added.txt'), 'added-later\n')
    assert.equal(existsSync(path.join(dir, 'del.txt')), false)
  } finally {
    await h.cleanup()
  }
})

test('restore approval action is file.write on "." with agentId and detail.changes', async () => {
  const h = await makeApp()
  try {
    const id = 'agent-action'
    await ensureAgent(h, id)
    const dir = ensureWorkdir(h.dataDir, id)
    write(dir, 'f.txt', 'v1\n')
    const s = svc(h)
    const a = await s.snapshot(id, 'a')
    write(dir, 'f.txt', 'v2\n')
    write(dir, 'g.txt', 'new\n')

    let captured: ApprovalRequest | undefined
    const off = h.app.ctx.on('whales/approval-requested', (req: ApprovalRequest) => {
      captured = req
      h.app.ctx.get('approvals')?.answer(req.id, 'allow-once')
    })
    try {
      await s.restore(a.id)
    } finally {
      off()
    }

    assert.ok(captured, 'an approval request must have been raised')
    assert.equal(captured.action.kind, 'file.write')
    assert.equal(captured.action.target, '.')
    assert.equal(captured.action.agentId, id)
    const detail = captured.action.detail as { changes?: { path: string }[] } | undefined
    assert.ok(detail?.changes, 'detail.changes must be present')
    const paths = detail.changes.map((c) => c.path)
    assert.ok(paths.includes('f.txt'))
    assert.ok(paths.includes('g.txt'))
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// per-agent plugin
// ---------------------------------------------------------------------------

test('AgentCheckpoints snapshots before and after each turn with the same turnId', async () => {
  const h = await makeApp()
  try {
    const handle = await spawnAgent(h, 'agent-turn')
    await ensureAgent(h, 'agent-turn')
    ensureWorkdir(h.dataDir, 'agent-turn')
    for await (const _ of handle.runtime?.turn('hi') ?? []) void _

    const s = svc(h)
    const list = s.list('agent-turn')
    const before = list.filter((c) => c.phase === 'before')
    const after = list.filter((c) => c.phase === 'after')
    assert.ok(before.length >= 1, 'expected a before checkpoint')
    assert.ok(after.length >= 1, 'expected an after checkpoint')
    const b = before[0]
    const a = after[0]
    assert.ok(b?.turnId)
    assert.equal(b?.turnId, a?.turnId)
  } finally {
    await h.cleanup()
  }
})

test('an agent without the checkpoints plugin creates no checkpoints', async () => {
  const h = await makeApp()
  try {
    const handle = await spawnAgent(h, 'agent-noplugin', [])
    await ensureAgent(h, 'agent-noplugin')
    ensureWorkdir(h.dataDir, 'agent-noplugin')
    for await (const _ of handle.runtime?.turn('hi') ?? []) void _
    const s = svc(h)
    assert.equal(s.list('agent-noplugin').length, 0)
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// attacks
// ---------------------------------------------------------------------------

test('malicious .git hooks and fsmonitor never run; .git is excluded from snapshots', async () => {
  const h = await makeApp()
  try {
    const id = 'agent-hooks'
    await ensureAgent(h, id)
    const dir = ensureWorkdir(h.dataDir, id)
    const marker = path.join(h.tmp, 'hook-marker')
    const script = path.join(h.tmp, 'fsmonitor.sh')
    writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`)
    chmodSync(script, 0o755)

    mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true })
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`)
    chmodSync(hook, 0o755)
    writeFileSync(
      path.join(dir, '.git', 'config'),
      `[core]\n\thooksPath = .git/hooks\n\tfsmonitor = ${script}\n`,
    )
    write(dir, 'tracked.txt', 'hello\n')

    const s = svc(h)
    const a = await s.snapshot(id, 'a')
    write(dir, 'tracked.txt', 'hello world\n')
    const b = await s.snapshot(id, 'b')
    const { changes } = await s.diff(a.id, b.id)

    assert.equal(existsSync(marker), false, 'hook/fsmonitor must not have run')
    for (const c of changes) {
      assert.ok(!c.path.startsWith('.git/'), `changes must not include .git: ${c.path}`)
    }

    const stop = autoAnswer(h, 'allow-once')
    try {
      await s.restore(a.id)
    } finally {
      stop()
    }
    assert.equal(existsSync(marker), false, 'restore must not run hooks')
  } finally {
    await h.cleanup()
  }
})

test('.gitattributes filter driver never runs', async () => {
  const h = await makeApp()
  try {
    const id = 'agent-filter'
    await ensureAgent(h, id)
    const dir = ensureWorkdir(h.dataDir, id)
    const marker = path.join(h.tmp, 'filter-marker')

    mkdirSync(path.join(dir, '.git'), { recursive: true })
    writeFileSync(
      path.join(dir, '.git', 'config'),
      `[filter "evil"]\n\tclean = touch ${JSON.stringify(marker)}\n\tsmudge = cat\n`,
    )
    writeFileSync(path.join(dir, '.gitattributes'), '* filter=evil\n')
    write(dir, 'data.txt', 'content\n')

    const s = svc(h)
    const a = await s.snapshot(id, 'a')
    write(dir, 'data.txt', 'content changed\n')
    const b = await s.snapshot(id, 'b')
    await s.diff(a.id, b.id)

    assert.equal(existsSync(marker), false, 'filter driver must not run')
  } finally {
    await h.cleanup()
  }
})

test('GIT_DIR / GIT_WORK_TREE / GIT_CONFIG_PARAMETERS env injection is neutralised', async () => {
  const h = await makeApp()
  try {
    const id = 'agent-env'
    await ensureAgent(h, id)
    const dir = ensureWorkdir(h.dataDir, id)
    write(dir, 'f.txt', 'v1\n')

    const decoy = mkdtempSync(path.join(tmpdir(), 'ckpt-decoy-'))
    const saved = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS,
    }
    process.env.GIT_DIR = path.join(decoy, 'gitdir')
    process.env.GIT_WORK_TREE = decoy
    process.env.GIT_CONFIG_PARAMETERS = "'core.hooksPath'='/tmp/x'"

    try {
      const s = svc(h)
      const a = await s.snapshot(id, 'a')
      assert.match(a.ref, HEX40)
      assert.ok(existsSync(path.join(h.dataDir, 'checkpoints', `${id}.git`, 'HEAD')))
      assert.deepEqual(readdirSync(decoy), [], 'decoy dir must stay empty')
    } finally {
      if (saved.GIT_DIR === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved.GIT_DIR
      if (saved.GIT_WORK_TREE === undefined) delete process.env.GIT_WORK_TREE
      else process.env.GIT_WORK_TREE = saved.GIT_WORK_TREE
      if (saved.GIT_CONFIG_PARAMETERS === undefined) delete process.env.GIT_CONFIG_PARAMETERS
      else process.env.GIT_CONFIG_PARAMETERS = saved.GIT_CONFIG_PARAMETERS
      rmSync(decoy, { recursive: true, force: true })
    }
  } finally {
    await h.cleanup()
  }
})

test('symlink pointing outside is snapshotted and restored as a symlink without writing through it', async () => {
  const h = await makeApp()
  try {
    const id = 'agent-symlink'
    await ensureAgent(h, id)
    const dir = ensureWorkdir(h.dataDir, id)
    const outside = mkdtempSync(path.join(tmpdir(), 'ckpt-outside-'))
    const outsideFile = path.join(outside, 'secret.txt')
    writeFileSync(outsideFile, 'outside-original\n')

    symlinkSync(outsideFile, path.join(dir, 'link.txt'))
    write(dir, 'plain.txt', 'plain\n')

    const s = svc(h)
    const a = await s.snapshot(id, 'a')

    // mutate: remove the symlink and change the outside file
    rmSync(path.join(dir, 'link.txt'))
    writeFileSync(outsideFile, 'outside-changed\n')

    const stop = autoAnswer(h, 'allow-once')
    try {
      await s.restore(a.id)
    } finally {
      stop()
    }

    const linkPath = path.join(dir, 'link.txt')
    assert.ok(existsSync(linkPath), 'symlink must be restored')
    assert.ok(lstatSync(linkPath).isSymbolicLink(), 'restored entry must be a symlink')
    assert.equal(readFileSync(outsideFile, 'utf8'), 'outside-changed\n', 'must not write through the symlink')
  } finally {
    await h.cleanup()
  }
})

test('agent id path traversal is rejected and creates nothing outside the checkpoints dir', async () => {
  const h = await makeApp()
  try {
    const s = svc(h)
    await assert.rejects(() => s.snapshot('../evil', 'x'))
    const ckptDir = path.join(h.dataDir, 'checkpoints')
    if (existsSync(ckptDir)) {
      for (const entry of readdirSync(ckptDir)) {
        assert.ok(!entry.includes('evil'), `unexpected entry: ${entry}`)
      }
    }
    assert.equal(existsSync(path.join(h.dataDir, 'evil.git')), false)
  } finally {
    await h.cleanup()
  }
})

test('shadow repo lives outside the workspace', async () => {
  const h = await makeApp()
  try {
    const id = 'agent-shadow'
    await ensureAgent(h, id)
    const dir = ensureWorkdir(h.dataDir, id)
    write(dir, 'f.txt', 'v1\n')
    const s = svc(h)
    await s.snapshot(id, 'a')

    assert.equal(existsSync(path.join(dir, '.git')), false, 'workspace must not gain a .git')
    assert.ok(existsSync(path.join(h.dataDir, 'checkpoints', `${id}.git`, 'HEAD')))
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------

test('5 parallel snapshots all succeed with distinct refs', async () => {
  const h = await makeApp()
  try {
    const id = 'agent-parallel'
    await ensureAgent(h, id)
    const dir = ensureWorkdir(h.dataDir, id)
    write(dir, 'f.txt', 'v1\n')
    const s = svc(h)

    const results = await Promise.all([
      s.snapshot(id, 'p1'),
      s.snapshot(id, 'p2'),
      s.snapshot(id, 'p3'),
      s.snapshot(id, 'p4'),
      s.snapshot(id, 'p5'),
    ])
    assert.equal(results.length, 5)
    const refs = new Set(results.map((r) => r.ref))
    assert.equal(refs.size, 5, 'refs must be distinct')
    for (const r of results) assert.match(r.ref, HEX40)
  } finally {
    await h.cleanup()
  }
})

// keep execFileSync import used (git availability probe) to avoid unused import
test('git binary is available', () => {
  const out = execFileSync('git', ['--version'], { encoding: 'utf8' })
  assert.match(out, /git version/)
})

test('git config injected through the environment cannot run a filter on agent-written .gitattributes', async () => {
  const h = await makeApp()
  const saved = { p: process.env.GIT_CONFIG_PARAMETERS, c: process.env.GIT_CONFIG_COUNT, k: process.env.GIT_CONFIG_KEY_0, v: process.env.GIT_CONFIG_VALUE_0 }
  const marker = path.join(h.tmp, 'filter-ran')
  try {
    await ensureAgent(h, 'agent-filter')
    const dir = ensureWorkdir(h.dataDir, 'agent-filter')
    // The agent controls its workspace, so it can write .gitattributes; only the environment could define the filter.
    write(dir, '.gitattributes', '* filter=evil\n')
    write(dir, 'a.txt', 'x\n')
    process.env.GIT_CONFIG_PARAMETERS = `'filter.evil.clean'='touch ${marker}'`
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'filter.evil.smudge'
    process.env.GIT_CONFIG_VALUE_0 = `touch ${marker}`
    const s = svc(h)
    const c1 = await s.snapshot('agent-filter', 'with attributes')
    write(dir, 'a.txt', 'y\n')
    await s.diff(c1.id)
    const off = autoAnswer(h, 'allow-once')
    try {
      await s.restore(c1.id)
    } finally {
      off()
    }
    assert.equal(existsSync(marker), false, 'a filter command from the environment ran')
  } finally {
    for (const [name, value] of [['GIT_CONFIG_PARAMETERS', saved.p], ['GIT_CONFIG_COUNT', saved.c], ['GIT_CONFIG_KEY_0', saved.k], ['GIT_CONFIG_VALUE_0', saved.v]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await h.cleanup()
  }
})
