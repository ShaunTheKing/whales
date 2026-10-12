import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import { MemorySecrets } from '../../src/core/keychain.ts'
import { createApi } from '../../src/server/api.ts'
import type {} from '../../src/contracts/index.ts'

const KEY = 'sk-api-test-abcdef123456'

test('providers API: create with key, never echo it, rotate, clear, delete', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'whales-providers-api-'))
  const secrets = new MemorySecrets()
  const app = await createApp({ config: defaultConfig({ env: {}, home: tmp, cwd: tmp }), storePath: ':memory:', services: { checkpoints: false, routines: false, market: false, providers: { secrets } } })
  t.after(async () => {
    await app.stop()
    await rm(tmp, { recursive: true, force: true })
  })
  const api = createApi(app)
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api.request(path, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    const text = await res.text()
    assert.ok(!text.includes(KEY) && !text.includes('sk-rotated-999999'), `${method} ${path} leaked a key`)
    return { status: res.status, data: text ? (JSON.parse(text) as Record<string, unknown>) : undefined }
  }

  const list = await call('GET', '/providers')
  assert.equal(list.data?.secretStore, 'memory')
  assert.ok((list.data?.presets as { kind: string }[]).some((p) => p.kind === 'opencode'))

  const created = await call('POST', '/providers', { kind: 'opencode', apiKey: KEY, models: ['m1'] })
  assert.equal(created.status, 201)
  assert.equal(created.data?.key, 'keychain')
  assert.equal(created.data?.baseUrl, 'https://opencode.ai/zen/v1')
  assert.equal(await secrets.get('opencode'), KEY)

  assert.equal((await call('POST', '/providers', { kind: 'openai', apiKey: 'bad key' })).status, 400)
  assert.equal((await call('PUT', '/providers/opencode/key', { apiKey: 'sk-rotated-999999' })).status, 204)
  assert.equal(await secrets.get('opencode'), 'sk-rotated-999999')
  assert.equal((await call('PATCH', '/providers/opencode', { defaultModel: 'm1', name: 'Zen' })).data?.name, 'Zen')

  await app.ctx.agents.spawn({ id: 'ann', name: 'Ann', seniority: 1, driver: { name: 'driver-openai-compat', config: { provider: 'opencode' } }, plugins: [] })
  const agents = (await call('GET', '/agents')).data as unknown as { driver: { provider?: string; model?: string } }[]
  assert.equal(agents[0]?.driver.provider, 'opencode')
  assert.equal((await call('DELETE', '/providers/opencode')).status, 409)
  await app.ctx.agents.dispose('ann', { forget: true })

  assert.equal((await call('DELETE', '/providers/opencode/key')).status, 204)
  assert.equal(await secrets.get('opencode'), undefined)
  assert.equal((await call('DELETE', '/providers/opencode')).status, 204)
  assert.equal((await call('DELETE', '/providers/opencode')).status, 404)
  assert.equal((await call('PUT', '/providers/ghost/key', { apiKey: KEY })).status, 404)
})
