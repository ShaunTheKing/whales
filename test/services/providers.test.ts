import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, type App } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import { MacKeychain, MemorySecrets } from '../../src/core/keychain.ts'
import type { DriverEvent } from '../../src/contracts/driver.ts'
import type {} from '../../src/contracts/index.ts'

const KEY = 'sk-test-0123456789abcdef'

async function setup(t: { after(fn: () => Promise<void>): void }, secrets = new MemorySecrets()): Promise<{ app: App; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'whales-providers-'))
  const app = await createApp({
    config: { ...defaultConfig(), dataDir: dir },
    storePath: ':memory:',
    services: { checkpoints: false, routines: false, market: false, providers: { secrets } },
  })
  t.after(async () => {
    await app.stop()
    await rm(dir, { recursive: true, force: true })
  })
  return { app, dir }
}

/** A fake OpenAI-compatible server that records auth headers. */
async function fakeApi(t: { after(fn: () => Promise<void>): void }) {
  const seen: IncomingHttpHeaders[] = []
  const server = createServer((req, res) => {
    seen.push(req.headers)
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `bad key ${req.headers.authorization ?? ''}` } }))
      return
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'bad id with spaces' }] }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi from provider' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => void server.close())
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen }
}

test('create a provider with a key: the key is stored only in the secret store', async (t) => {
  const secrets = new MemorySecrets()
  const { app } = await setup(t, secrets)
  const view = await app.ctx.providers.create({ kind: 'deepseek', apiKey: KEY })
  assert.equal(view.id, 'deepseek')
  assert.equal(view.key, 'keychain')
  assert.equal(view.defaultModel, 'deepseek-chat')
  assert.equal(await secrets.get('deepseek'), KEY)
  const raw = JSON.stringify(app.ctx.store.collection('providers').list())
  assert.ok(!raw.includes(KEY), 'record must not contain the key')
  assert.ok(!JSON.stringify(await app.ctx.providers.list()).includes(KEY), 'views must not contain the key')
  const second = await app.ctx.providers.create({ kind: 'deepseek', name: 'Work' })
  assert.equal(second.id, 'deepseek-2')
  assert.equal(second.key, process.env.DEEPSEEK_API_KEY ? 'env' : 'none')
})

test('validation: kinds, URLs, keys over http, model ids, env names', async (t) => {
  const { app } = await setup(t)
  const p = app.ctx.providers
  await assert.rejects(p.create({ kind: 'nope' as 'openai' }), /kind/)
  await assert.rejects(p.create({ kind: 'custom' }), /base URL is required/)
  await assert.rejects(p.create({ kind: 'custom', baseUrl: 'http://example.com/v1' }), /https/)
  await assert.rejects(p.create({ kind: 'custom', baseUrl: 'https://u:p@example.com/v1' }), /credentials/)
  await assert.rejects(p.create({ kind: 'openai', apiKey: 'short' }), /API key/)
  await assert.rejects(p.create({ kind: 'openai', apiKey: 'sk-has"quote-1234' }), /API key/)
  await assert.rejects(p.create({ kind: 'openai', apiKey: 'sk-has space-1234' }), /API key/)
  await assert.rejects(p.create({ kind: 'openai', models: ['ok', 'not ok'] }), /model ids/)
  await assert.rejects(p.create({ kind: 'openai', keyEnv: 'lower' }), /NAME/)
  const local = await p.create({ kind: 'ollama' })
  assert.equal(local.baseUrl, 'http://127.0.0.1:11434/v1')
  await p.setKey(local.id, KEY) // loopback http is fine
  const remote = await p.create({ kind: 'custom', baseUrl: 'https://example.com/v1' })
  await p.setKey(remote.id, KEY)
  await assert.rejects(p.update(remote.id, { baseUrl: 'http://127.0.0.2/v1' }), /https/)
})

test('no secure storage: keys are refused with a clear message, env names still work', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'whales-providers-'))
  const app = await createApp({ config: { ...defaultConfig(), dataDir: dir }, storePath: ':memory:', services: { checkpoints: false, routines: false, market: false, providers: { secrets: false } } })
  t.after(async () => {
    await app.stop()
    await rm(dir, { recursive: true, force: true })
  })
  assert.equal(app.ctx.providers.secretStore, 'none')
  await assert.rejects(app.ctx.providers.create({ kind: 'openai', apiKey: KEY }), /no secure key storage/)
  const view = await app.ctx.providers.create({ kind: 'openai', keyEnv: 'WHALES_TEST_UNSET_KEY' })
  assert.equal(view.key, 'none')
})

test('test(): lists models with the saved key; errors never contain the key', async (t) => {
  const { app } = await setup(t)
  const api = await fakeApi(t)
  const ok = await app.ctx.providers.create({ kind: 'custom', baseUrl: api.baseUrl, apiKey: KEY })
  assert.deepEqual(await app.ctx.providers.test(ok.id), { ok: true, models: ['model-a', 'model-b'] })

  const wrong = await app.ctx.providers.create({ kind: 'custom', name: 'Wrong', baseUrl: api.baseUrl, apiKey: 'sk-wrong-key-987654321' })
  const result = await app.ctx.providers.test(wrong.id)
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /HTTP 401/)
  assert.ok(!(result.error ?? '').includes('sk-wrong-key-987654321'), 'echoed key must be redacted')

  const keyless = await app.ctx.providers.create({ kind: 'openai', keyEnv: 'WHALES_TEST_UNSET_KEY' })
  assert.match((await app.ctx.providers.test(keyless.id)).error ?? '', /no API key/)
})

test('agents use a provider: driver gets base URL, default model and the Keychain key at call time', async (t) => {
  const secrets = new MemorySecrets()
  const { app } = await setup(t, secrets)
  const api = await fakeApi(t)
  const provider = await app.ctx.providers.create({ kind: 'custom', baseUrl: api.baseUrl, models: ['model-a'], apiKey: KEY })
  // Custom providers do not require a key, so prove the key is used by checking the header the server saw.
  const agent = await app.ctx.agents.spawn({ id: 'ann', name: 'Ann', seniority: 1, driver: { name: 'driver-openai-compat', config: { provider: provider.id, tools: false } }, plugins: [] })
  assert.equal(agent.ctx.get('driver')?.model, 'model-a')
  const events: DriverEvent[] = []
  for await (const e of agent.runtime!.turn('hello')) events.push(e)
  assert.equal(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join(''), 'hi from provider')
  assert.equal(api.seen.at(-1)?.authorization, `Bearer ${KEY}`)

  // Key rotated in the Keychain: next turn uses it without restarting the agent.
  await app.ctx.providers.setKey(provider.id, 'sk-rotated-key-111111')
  const after: DriverEvent[] = []
  for await (const e of agent.runtime!.turn('again')) after.push(e)
  assert.equal(api.seen.at(-1)?.authorization, 'Bearer sk-rotated-key-111111')
  const error = after.find((e) => e.type === 'error') as { message: string } | undefined
  assert.ok(error, 'server rejects the rotated key')
  assert.ok(!error.message.includes('sk-rotated-key-111111'), 'driver errors are redacted')

  await assert.rejects(app.ctx.providers.delete(provider.id), /still used by agent ann/)
  await assert.rejects(
    app.ctx.agents.spawn({ id: 'bob', name: 'Bob', seniority: 1, driver: { name: 'driver-openai-compat', config: { provider: 'ghost', model: 'x' } }, plugins: [] }),
    /unknown provider/,
  )
  await assert.rejects(
    app.ctx.agents.spawn({ id: 'cy', name: 'Cy', seniority: 1, driver: { name: 'driver-openai-compat', config: { provider: provider.id, baseUrl: 'https://evil.example/v1' } }, plugins: [] }),
    /cannot be combined/,
  )
})

test('a provider that needs a key fails the turn clearly when none is saved', async (t) => {
  const { app } = await setup(t)
  const provider = await app.ctx.providers.create({ kind: 'opencode', keyEnv: 'WHALES_TEST_UNSET_KEY', models: ['some-model'] })
  const agent = await app.ctx.agents.spawn({ id: 'ann', name: 'Ann', seniority: 1, driver: { name: 'driver-openai-compat', config: { provider: provider.id } }, plugins: [] })
  const events: DriverEvent[] = []
  for await (const e of agent.runtime!.turn('hello')) events.push(e)
  assert.match((events.find((e) => e.type === 'error') as { message: string }).message, /no API key saved for provider opencode/)
  assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'error' })
  await app.ctx.agents.dispose('ann', { forget: true })
  assert.equal(await app.ctx.providers.delete(provider.id), true)
})

test('MacKeychain: the key goes over stdin, never argv; read/delete round-trip', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'whales-fake-security-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const bin = join(dir, 'security')
  await writeFile(
    bin,
    `#!/bin/sh
D='${dir}'
echo "$@" >> "$D/argv.log"
case "$1" in
  -i) line=$(/bin/cat); echo "$line" >> "$D/stdin.log"
      acct=$(echo "$line" | /usr/bin/sed -E 's/.* -a "([^"]*)".*/\\1/')
      pw=$(echo "$line" | /usr/bin/sed -E 's/.* -w "([^"]*)".*/\\1/')
      printf '%s' "$pw" > "$D/item-$acct"; exit 0 ;;
  find-generic-password) [ -f "$D/item-$5" ] || exit 44; /bin/cat "$D/item-$5"; echo; exit 0 ;;
  delete-generic-password) [ -f "$D/item-$5" ] || exit 44; /bin/rm -f "$D/item-$5"; exit 0 ;;
esac
exit 1
`,
  )
  await chmod(bin, 0o755)
  const kc = new MacKeychain(bin)
  assert.equal(await kc.get('openai'), undefined)
  await kc.set('openai', KEY, 'Whales: OpenAI')
  assert.equal(await kc.get('openai'), KEY)
  const argv = await readFile(join(dir, 'argv.log'), 'utf8')
  assert.ok(!argv.includes(KEY), 'key must never be in argv')
  assert.match(await readFile(join(dir, 'stdin.log'), 'utf8'), /^add-generic-password -U -s "whales\.provider" -a "openai" -l "Whales: OpenAI" -w "sk-test-0123456789abcdef"$/m)
  await kc.delete('openai')
  assert.equal(await kc.get('openai'), undefined)
  await kc.delete('openai') // already gone: fine
  await assert.rejects(kc.set('openai', 'sk-x" ; delete-keychain login', 'x'), /API key/)
  await assert.rejects(kc.get('../evil'), /invalid keychain account/)
})

test('OpenCode Go: stable x-opencode-session per conversation, different across conversations, absent elsewhere', async (t) => {
  const { app } = await setup(t)
  const api = await fakeApi(t)
  const go = await app.ctx.providers.create({ kind: 'opencode-go', baseUrl: api.baseUrl, models: ['m'], apiKey: KEY })
  const plain = await app.ctx.providers.create({ kind: 'custom', baseUrl: api.baseUrl, models: ['m'], apiKey: KEY })
  const spawn = (id: string, provider: string) =>
    app.ctx.agents.spawn({ id, name: id, seniority: 1, driver: { name: 'driver-openai-compat', config: { provider, tools: false } }, plugins: [] })
  const ann = await spawn('ann', go.id)
  const bob = await spawn('bob', go.id)
  const cy = await spawn('cy', plain.id)
  const session = async (agent: typeof ann, roomId?: string) => {
    for await (const _ of agent.runtime!.turn('hi', roomId ? { roomId, history: [] } : {})) void _
    return api.seen.at(-1)?.['x-opencode-session']
  }
  const annDm1 = await session(ann)
  const annDm2 = await session(ann)
  const annRoom = await session(ann, 'room_1')
  const annRoom2 = await session(ann, 'room_2')
  const bobDm = await session(bob)
  assert.match(String(annDm1), /^whales-[0-9a-f]{32}$/)
  assert.equal(annDm1, annDm2, 'same conversation keeps its session')
  assert.equal(new Set([annDm1, annRoom, annRoom2, bobDm]).size, 4, 'each conversation has its own session')
  assert.equal(await session(cy), undefined, 'other providers never get the header')

  assert.equal((await app.ctx.providers.test(go.id)).ok, true)
  assert.match(String(api.seen.at(-1)?.['x-opencode-session']), /^whales-test-/)
})
