import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import { createApi } from '../../src/server/api.ts'
import type { AgentSpec } from '../../src/contracts/core.ts'
import type { InstallPreview, InstalledView, CatalogEntry } from '../../src/contracts/market.ts'
import type {} from '../../src/contracts/index.ts'

const PLUGINS = join(import.meta.dirname, '../../plugins')

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const tmp = await mkdtemp(join(tmpdir(), 'whales-plugins-api-'))
  const app = await createApp({ config: defaultConfig({ env: {}, home: tmp, cwd: tmp }), storePath: ':memory:', services: { checkpoints: false, routines: false } })
  t.after(async () => {
    await app.stop()
    await rm(tmp, { recursive: true, force: true })
  })
  const api = createApi(app)
  const call = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method }
    if (body !== undefined) {
      init.body = JSON.stringify(body)
      init.headers = { 'content-type': 'application/json' }
    }
    const res = await api.request(path, init)
    const text = await res.text()
    return { status: res.status, data: text ? (JSON.parse(text) as unknown) : undefined }
  }
  return { app, call }
}

const spec = (id: string): AgentSpec => ({ id, name: id, seniority: 1, driver: { name: 'driver-stub' }, plugins: [] })

test('install a local plugin over the API, attach it to an agent and a room, then uninstall', async (t) => {
  const { app, call } = await setup(t)
  await app.ctx.agents.spawn(spec('ann'))

  const pv = await call('POST', '/market/preview', { local: join(PLUGINS, 'dice') })
  assert.equal(pv.status, 201)
  const preview = pv.data as InstallPreview
  assert.equal((await call('POST', '/market/install', { previewId: preview.id, digest: preview.digest })).status, 400, 'acknowledge is required')
  const inst = await call('POST', '/market/install', { previewId: preview.id, digest: preview.digest, acknowledge: true })
  assert.equal(inst.status, 201)
  assert.equal((inst.data as InstalledView).state, 'loaded')

  const catalog = (await call('GET', '/catalog')).data as CatalogEntry[]
  assert.deepEqual(catalog.find((c) => c.name === 'dice'), { name: 'dice', kind: 'market', description: preview.manifest.description, version: '1.0.0', scopes: ['agent', 'room'] })
  assert.equal(catalog.find((c) => c.name === 'memory')?.kind, 'builtin')

  const put = await call('PUT', '/agents/ann/plugins', { plugins: [{ name: 'dice' }] })
  assert.equal(put.status, 200)
  assert.deepEqual((put.data as { plugins: string[] }).plugins, ['dice'])
  assert.deepEqual(app.ctx.agents.get('ann')?.ctx.get('tools')?.list().map((s) => s.name), ['roll_dice'])
  assert.equal((await call('PUT', '/agents/ann/plugins', { plugins: [{ name: 'nope' }] })).status, 400)
  assert.equal((await call('PUT', '/agents/ann/plugins', { plugins: [{ name: 'dice' }, { name: 'dice' }] })).status, 400)
  assert.equal((await call('PUT', '/agents/ghost/plugins', { plugins: [] })).status, 404)

  const room = (await call('POST', '/rooms', { name: 'r', members: ['ann'] })).data as { id: string }
  const roomPut = await call('PUT', `/rooms/${room.id}/plugins`, { plugins: [{ name: 'dice', config: { sides: 20 } }] })
  assert.equal(roomPut.status, 200)
  assert.deepEqual((roomPut.data as { status: { state: string }[] }).status.map((s) => s.state), ['active'])
  assert.equal((await call('PUT', `/rooms/${room.id}/plugins`, { plugins: [{ name: 'memory' }] })).status, 400)
  assert.equal((await call('PUT', '/rooms/nope/plugins', { plugins: [] })).status, 404)

  const blocked = await call('DELETE', '/market/plugins/dice')
  assert.equal(blocked.status, 409)
  assert.match((blocked.data as { error: string }).error, /agent ann.*room/)
  await call('PUT', '/agents/ann/plugins', { plugins: [] })
  await call('PUT', `/rooms/${room.id}/plugins`, { plugins: [] })
  assert.equal((await call('DELETE', '/market/plugins/dice')).status, 204)
  assert.equal((await call('DELETE', '/market/plugins/dice')).status, 404)
})

test('market sources and preview errors', async (t) => {
  const { call } = await setup(t)
  assert.equal((await call('POST', '/market/sources', { url: 'http://insecure.example/index.json' })).status, 400)
  const added = await call('POST', '/market/sources', { url: 'https://example.invalid/index.json' })
  assert.equal(added.status, 201)
  const browse = (await call('GET', '/market/browse')).data as { error?: string }[]
  assert.equal(browse.length, 1)
  assert.ok(browse[0]?.error)
  assert.equal((await call('DELETE', `/market/sources/${(added.data as { id: string }).id}`)).status, 204)
  assert.equal((await call('POST', '/market/preview', {})).status, 400)
  assert.equal((await call('POST', '/market/preview', { repo: 'https://gitlab.com/a/b', commit: 'a'.repeat(40) })).status, 400)
  assert.equal((await call('POST', '/market/install', { previewId: 'nope', digest: 'x', acknowledge: true })).status, 404)
})
