import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, LookupFunction } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createApp, type App } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import { MemorySecrets } from '../../src/core/keychain.ts'
import { BlockedAddressError, checkPublicUrl, fetchPublicText, guardedLookup, htmlToText, isPrivateAddress } from '../../src/core/web.ts'
import type {} from '../../src/contracts/index.ts'

const KEY = 'search-key-0123456789'

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void

async function server(t: { after(fn: () => Promise<void>): void }, handler: Handler): Promise<string> {
  const s = createServer((req, res) => {
    let body = ''
    req.on('data', (d: Buffer) => (body += d.toString()))
    req.on('end', () => handler(req, res, body))
  })
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  t.after(async () => void s.close())
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}

async function setup(t: { after(fn: () => Promise<void>): void }, endpoints: Record<string, string> = {}, secrets = new MemorySecrets()): Promise<App> {
  const dir = await mkdtemp(join(tmpdir(), 'whales-search-'))
  const app = await createApp({
    config: { ...defaultConfig(), dataDir: dir },
    storePath: ':memory:',
    services: { checkpoints: false, routines: false, market: false, providers: false, search: { secrets, endpoints } },
  })
  t.after(async () => {
    await app.stop()
    await rm(dir, { recursive: true, force: true })
  })
  return app
}

test('Brave: key header, query, HTML stripped from snippets; key never in status; errors redacted', async (t) => {
  let seen: IncomingMessage | undefined
  const base = await server(t, (req, res) => {
    seen = req
    if (req.headers['x-subscription-token'] !== KEY) {
      res.writeHead(401).end(`bad token ${String(req.headers['x-subscription-token'])}`)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ web: { results: [{ title: 'Whales <strong>news</strong>', url: 'https://example.com/a', description: 'Big &amp; <b>blue</b>', age: '2 days ago' }, { title: 'bad', url: 'javascript:alert(1)' }] } }),
    )
  })
  const secrets = new MemorySecrets()
  const app = await setup(t, { brave: `${base}/res/v1/web/search` }, secrets)
  await assert.rejects(app.ctx.search.search('x'), /not set up yet/)
  const status = await app.ctx.search.configure({ kind: 'brave', apiKey: KEY })
  assert.equal(status.config?.key, 'keychain')
  assert.ok(!JSON.stringify(status).includes(KEY))
  assert.equal(await secrets.get('search-brave'), KEY)

  const results = await app.ctx.search.search('whale song', { count: 3 })
  assert.deepEqual(results, [{ title: 'Whales news', url: 'https://example.com/a', snippet: 'Big & blue', published: '2 days ago' }])
  assert.match(String(seen?.url), /q=whale\+song&count=3/)

  await secrets.set('search-brave', 'wrong-key-999999')
  const failed = await app.ctx.search.test()
  assert.equal(failed.ok, false)
  assert.match(failed.error ?? '', /HTTP 401 \(check the API key\)/)
  assert.ok(!(failed.error ?? '').includes('wrong-key-999999'), 'echoed key is redacted')
})

test('Tavily: POST body with bearer key; SearXNG: own URL, json format, no key', async (t) => {
  const tavily = await server(t, (req, res, body) => {
    assert.equal(req.method, 'POST')
    assert.equal(req.headers.authorization, `Bearer ${KEY}`)
    const parsed = JSON.parse(body) as { query: string; max_results: number }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: [{ title: parsed.query, url: 'https://t.example/', content: `n=${parsed.max_results}` }] }))
  })
  const app = await setup(t, { tavily: `${tavily}/search` })
  await app.ctx.search.configure({ kind: 'tavily', apiKey: KEY })
  assert.deepEqual(await app.ctx.search.search('q1', { count: 2 }), [{ title: 'q1', url: 'https://t.example/', snippet: 'n=2' }])

  const searx = await server(t, (req, res) => {
    assert.match(String(req.url), /^\/search\?q=hello&format=json$/)
    assert.equal(req.headers.authorization, undefined)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: [{ title: 'S', url: 'http://s.example/x', content: 'c', publishedDate: '2026-10-01' }] }))
  })
  await assert.rejects(app.ctx.search.configure({ kind: 'searxng' }), /needs the URL/)
  const status = await app.ctx.search.configure({ kind: 'searxng', baseUrl: `${searx}/` })
  assert.equal(status.config?.baseUrl, searx)
  assert.equal((await app.ctx.search.search('hello'))[0]?.published, '2026-10-01')
  await app.ctx.search.disable()
  assert.equal((await app.ctx.search.status()).config, undefined)
})

test('web-search plugin: tools, permissions and formatted results', async (t) => {
  const base = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ web: { results: [{ title: 'T', url: 'https://example.com/', description: 'd' }] } }))
  })
  const app = await setup(t, { brave: base })
  await app.ctx.search.configure({ kind: 'brave', apiKey: KEY })
  const agent = await app.ctx.agents.spawn({
    id: 'ann', name: 'Ann', seniority: 1, permissionMode: 'trusted',
    driver: { name: 'driver-stub' }, plugins: [{ name: 'web-search', config: { count: 2 } }],
  })
  const tools = agent.ctx.get('tools')!
  assert.deepEqual(tools.list().map((s) => s.name), ['web_search', 'web_open'])
  const signal = new AbortController().signal
  const found = await tools.forTurn({}).invoke({ id: '1', name: 'web_search', input: { query: 'whales' } }, signal)
  assert.equal(found.isError, false)
  assert.match(found.output, /\[1\] T\nhttps:\/\/example\.com\/\nd/)
  for (const url of ['http://127.0.0.1:8080/', 'http://localhost/', 'http://10.0.0.1/admin', 'http://[::1]/', 'file:///etc/passwd', 'http://169.254.169.254/latest']) {
    const blocked = await tools.forTurn({}).invoke({ id: '2', name: 'web_open', input: { url } }, signal)
    assert.equal(blocked.isError, true, url)
    assert.match(blocked.output, /invalid input|not allowed/, url)
  }
  const empty = await tools.forTurn({}).invoke({ id: '3', name: 'web_search', input: { query: '  ' } }, signal)
  assert.equal(empty.isError, true)
})

test('web-search is allowed as a room plugin; first search asks approval as a tool', async (t) => {
  const app = await setup(t)
  await app.ctx.agents.spawn({ id: 'ann', name: 'Ann', seniority: 1, driver: { name: 'driver-stub' }, plugins: [] })
  const room = app.ctx.rooms.create({ name: 'r', members: ['ann'] })
  app.ctx.rooms.setPlugins(room.id, [{ name: 'web-search' }])
  await app.ctx.roomPlugins.sync()
  assert.deepEqual(app.ctx.roomPlugins.status(room.id).map((s) => s.state), ['active'])
  const tools = app.ctx.agents.get('ann')!.ctx.get('tools')!
  const asked: string[] = []
  app.ctx.on('whales/approval-requested', (req) => {
    asked.push(`${req.action.kind}:${req.action.target}`)
    void app.ctx.approvals.answer(req.id, 'deny')
  })
  const out = await tools.forTurn({ roomId: room.id }).invoke({ id: '1', name: 'web_search', input: { query: 'x' } }, new AbortController().signal)
  assert.equal(out.isError, true)
  assert.deepEqual(asked, ['tool:web_search'])
})

test('fetchPublicText: reads pages, decodes gzip, converts HTML, re-checks every redirect', async (t) => {
  const base = await server(t, (req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
      res.end(gzipSync('<html><title>Hi</title><script>evil()</script><h2>News</h2><p>Whales &amp; <b>dolphins</b></p></html>'))
    } else if (req.url === '/hop') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/secret' }).end()
    } else if (req.url === '/hop-name') {
      res.writeHead(302, { location: 'http://router.local/' }).end()
    } else {
      res.writeHead(200, { 'content-type': 'image/png' }).end('png')
    }
  })
  const port = new URL(base).port
  // Tests resolve the made-up public name to the local test server; production uses guardedLookup.
  const lookup: LookupFunction = (_host, options, cb) => {
    if (options.all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: '127.0.0.1', family: 4 }])
    else cb(null, '127.0.0.1', 4)
  }
  const page = await fetchPublicText(`http://whales-test.example:${port}/page`, { lookup })
  assert.equal(page.text, 'Hi\n\n## News\nWhales & dolphins')
  await assert.rejects(fetchPublicText(`http://whales-test.example:${port}/hop`, { lookup }), BlockedAddressError)
  await assert.rejects(fetchPublicText(`http://whales-test.example:${port}/hop-name`, { lookup }), /local hosts/)
  assert.match((await fetchPublicText(`http://whales-test.example:${port}/img`, { lookup })).text, /not a text page/)
})

test('guardedLookup refuses names that resolve to private addresses', async () => {
  const err = await new Promise<Error | null>((resolve) => guardedLookup('localhost', {}, (e) => resolve(e)))
  assert.ok(err instanceof BlockedAddressError)
})

test('address classification and URL checks', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '224.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip)
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '172.32.0.1']) assert.equal(isPrivateAddress(ip), false, ip)
  assert.throws(() => checkPublicUrl('https://user:pw@example.com/'), /credentials/)
  assert.throws(() => checkPublicUrl('http://printer.local/'), /local hosts/)
  assert.equal(checkPublicUrl('https://example.com/x').href, 'https://example.com/x')
  assert.equal(htmlToText('<p>a&#33;&#x21;</p>'), 'a!!')
})
