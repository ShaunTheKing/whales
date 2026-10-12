import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, type App } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import { createApi } from '../../src/server/api.ts'
import type {} from '../../src/contracts/index.ts'
import type { AgentSpec } from '../../src/contracts/core.ts'
import type { Checkpoint, FileChange } from '../../src/contracts/checkpoints.ts'

interface Ctx {
  app: App
  api: ReturnType<typeof createApi>
  tmp: string
}

async function setup(): Promise<Ctx> {
  const tmp = await mkdtemp(join(tmpdir(), 'whales-ckpt-'))
  const cfg = defaultConfig({ env: {}, home: tmp, cwd: tmp })
  const app = await createApp({ config: cfg, storePath: ':memory:' })
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

function ckptSpec(id: string, plugins: AgentSpec['plugins']): AgentSpec {
  return {
    id,
    name: id,
    seniority: 1,
    driver: { name: 'driver-stub', config: { template: 'echo: {prompt}' } },
    plugins,
  }
}

function workdir(ctx: Ctx, id: string): string {
  return join(ctx.app.ctx.config.dataDir, 'workspaces', id)
}

describe('checkpoints api', () => {
  let ctx: Ctx
  before(async () => {
    ctx = await setup()
  })
  after(async () => {
    await teardown(ctx)
  })

  test('snapshot, list, diff and restore', async () => {
    const spec = ckptSpec('ck', [{ name: 'workspace' }, { name: 'checkpoints' }])
    const created = await ctx.api.request('/agents', jsonInit({ spec }))
    assert.equal(created.status, 201)

    const dir = workdir(ctx, 'ck')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'a.txt'), 'one\n', 'utf8')

    const snap = await ctx.api.request('/agents/ck/checkpoints', jsonInit({ label: 'first' }))
    assert.equal(snap.status, 201)
    const checkpoint = (await snap.json()) as Checkpoint
    assert.equal(checkpoint.agentId, 'ck')
    assert.equal(checkpoint.phase, 'manual')
    assert.equal(checkpoint.label, 'first')
    assert.equal(typeof checkpoint.ref, 'string')

    await writeFile(join(dir, 'a.txt'), 'two\n', 'utf8')
    await writeFile(join(dir, 'b.txt'), 'new\n', 'utf8')

    const list = await ctx.api.request('/agents/ck/checkpoints')
    assert.equal(list.status, 200)
    const listBody = (await list.json()) as Checkpoint[]
    assert.ok(listBody.some((cp) => cp.id === checkpoint.id))

    const diff = await ctx.api.request(`/checkpoints/${checkpoint.id}/diff`)
    assert.equal(diff.status, 200)
    const diffBody = (await diff.json()) as { changes: FileChange[]; patch: string }
    const paths = diffBody.changes.map((change) => change.path)
    assert.ok(paths.includes('a.txt'))
    assert.ok(paths.includes('b.txt'))
    assert.equal(typeof diffBody.patch, 'string')

    const allowListener = (req: { id: string }) => {
      ctx.app.ctx.get('approvals')?.answer(req.id, 'allow-once')
    }
    const offAllow = ctx.app.ctx.on('whales/approval-requested', allowListener)
    const restored = await ctx.api.request(`/checkpoints/${checkpoint.id}/restore`, { method: 'POST' })
    offAllow()
    assert.equal(restored.status, 200)
    const restoredBody = (await restored.json()) as { safety: Checkpoint }
    assert.equal(restoredBody.safety.agentId, 'ck')
    assert.equal(restoredBody.safety.phase, 'manual')

    const reverted = await readFile(join(dir, 'a.txt'), 'utf8')
    assert.equal(reverted, 'one\n')

    await ctx.api.request('/agents/ck', { method: 'DELETE' })
  })

  test('restore denied leaves files unchanged', async () => {
    const spec = ckptSpec('ck2', [{ name: 'workspace' }, { name: 'checkpoints' }])
    await ctx.api.request('/agents', jsonInit({ spec }))

    const dir = workdir(ctx, 'ck2')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'a.txt'), 'one\n', 'utf8')

    const snap = await ctx.api.request('/agents/ck2/checkpoints', jsonInit({ label: 'base' }))
    assert.equal(snap.status, 201)
    const checkpoint = (await snap.json()) as Checkpoint

    await writeFile(join(dir, 'a.txt'), 'two\n', 'utf8')

    const denyListener = (req: { id: string }) => {
      ctx.app.ctx.get('approvals')?.answer(req.id, 'deny')
    }
    const offDeny = ctx.app.ctx.on('whales/approval-requested', denyListener)
    const denied = await ctx.api.request(`/checkpoints/${checkpoint.id}/restore`, { method: 'POST' })
    offDeny()
    assert.equal(denied.status, 403)

    const unchanged = await readFile(join(dir, 'a.txt'), 'utf8')
    assert.equal(unchanged, 'two\n')

    await ctx.api.request('/agents/ck2', { method: 'DELETE' })
  })

  test('unknown checkpoint is 404', async () => {
    const res = await ctx.api.request('/checkpoints/nope/diff')
    assert.equal(res.status, 404)
    const restore = await ctx.api.request('/checkpoints/nope/restore', { method: 'POST' })
    assert.equal(restore.status, 404)
  })

  test('agent without the checkpoints plugin can be snapshotted manually', async () => {
    const spec = ckptSpec('plain', [{ name: 'workspace' }])
    await ctx.api.request('/agents', jsonInit({ spec }))

    const dir = workdir(ctx, 'plain')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'a.txt'), 'one\n', 'utf8')

    const snap = await ctx.api.request('/agents/plain/checkpoints', jsonInit({}))
    assert.equal(snap.status, 201)
    const checkpoint = (await snap.json()) as Checkpoint
    assert.equal(checkpoint.label, 'manual snapshot')
    assert.equal(checkpoint.phase, 'manual')

    await ctx.api.request('/agents/plain', { method: 'DELETE' })
  })

  test('unknown agent is 404', async () => {
    const list = await ctx.api.request('/agents/ghost/checkpoints')
    assert.equal(list.status, 404)
    const snap = await ctx.api.request('/agents/ghost/checkpoints', jsonInit({}))
    assert.equal(snap.status, 404)
  })
})
