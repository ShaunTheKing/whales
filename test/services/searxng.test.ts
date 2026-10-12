import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import { MemorySecrets } from '../../src/core/keychain.ts'
import { CONTAINER, SEARXNG_IMAGE, settingsYaml } from '../../src/services/searxng.ts'
import type {} from '../../src/contracts/index.ts'

/**
 * Fake `docker`: state lives in files under $D. `daemon` present = daemon up. `container` holds
 * "running|port|image". Every call is appended to `calls`.
 */
async function fakeDocker(dir: string): Promise<string> {
  const bin = join(dir, 'docker')
  await writeFile(
    bin,
    `#!/bin/sh
D='${dir}'
echo "$*" >> "$D/calls"
case "$1" in
  info) [ -f "$D/daemon" ] && echo 29.0.0 && exit 0; echo "cannot connect" >&2; exit 1 ;;
  inspect) [ -f "$D/container" ] || { echo "no such object" >&2; exit 1; }; /bin/cat "$D/container"; exit 0 ;;
  run)
    port=""; image=""
    for a in "$@"; do case "$a" in com.whales.port=*) port="\${a#com.whales.port=}";; searxng/*) image="$a";; esac; done
    echo "true|$port|$image" > "$D/container"; echo abc123; exit 0 ;;
  start) [ -f "$D/container" ] || exit 1; /usr/bin/sed -i '' 's/^false/true/' "$D/container"; exit 0 ;;
  stop) [ -f "$D/container" ] && /usr/bin/sed -i '' 's/^true/false/' "$D/container"; exit 0 ;;
  rm) /bin/rm -f "$D/container"; exit 0 ;;
esac
exit 1
`,
  )
  await chmod(bin, 0o755)
  return bin
}

async function fakeSearxng(t: { after(fn: () => Promise<void>): void }) {
  const queries: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/healthz') return void res.writeHead(200).end('OK')
    if (url.pathname === '/search' && url.searchParams.get('format') === 'json') {
      queries.push(url.searchParams.get('q') ?? '')
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: [{ title: 'Free', url: 'https://free.example/', content: 'no key needed' }] }))
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => void server.close())
  return { port: (server.address() as AddressInfo).port, queries }
}

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'whales-searxng-'))
  const dockerDir = join(dir, 'docker-state')
  await mkdir(dockerDir)
  const docker = await fakeDocker(dockerDir)
  const sx = await fakeSearxng(t)
  const app = await createApp({
    config: { ...defaultConfig(), dataDir: join(dir, 'data') },
    storePath: ':memory:',
    services: {
      checkpoints: false, routines: false, market: false, providers: false,
      search: { secrets: new MemorySecrets(), managed: { docker, pickPort: async () => sx.port, launchDesktop: false, daemonWaitMs: 200, readyWaitMs: 2000 } },
    },
  })
  t.after(async () => {
    await app.stop()
    await rm(dir, { recursive: true, force: true })
  })
  const calls = async () => (await readFile(join(dockerDir, 'calls'), 'utf8').catch(() => '')).trim().split('\n')
  return { app, dir, dockerDir, sx, calls }
}

test('with no backend chosen, the first search sets up SearXNG in Docker automatically', async (t) => {
  const { app, dir, dockerDir, sx, calls } = await setup(t)
  await writeFile(join(dockerDir, 'daemon'), '')
  assert.equal((await app.ctx.search.status()).managed?.state, 'not-created')

  const results = await app.ctx.search.search('free search')
  assert.deepEqual(results, [{ title: 'Free', url: 'https://free.example/', snippet: 'no key needed' }])
  assert.deepEqual(sx.queries, ['free search'])

  const status = await app.ctx.search.status()
  assert.equal(status.config?.kind, 'searxng')
  assert.equal(status.config?.managed, true)
  assert.equal(status.config?.baseUrl, `http://127.0.0.1:${sx.port}`)
  assert.equal(status.managed?.state, 'running')

  const run = (await calls()).find((c) => c.startsWith('run '))!
  assert.ok(run.includes(`-p 127.0.0.1:${sx.port}:8080`), 'published on loopback only')
  assert.ok(run.includes(`--name ${CONTAINER}`))
  assert.ok(run.endsWith(SEARXNG_IMAGE), 'pinned image')
  const settings = await readFile(join(dir, 'data', 'searxng', 'settings.yml'), 'utf8')
  assert.match(settings, /- json/)
  assert.match(settings, /limiter: false/)
  assert.match(settings, /secret_key: "[0-9a-f]{64}"/)
})

test('a stopped container is restarted before searching; Whales stops only what it started', async (t) => {
  const { app, dockerDir, calls } = await setup(t)
  await writeFile(join(dockerDir, 'daemon'), '')
  await app.ctx.search.useManagedSearxng()
  await writeFile(join(dockerDir, 'container'), (await readFile(join(dockerDir, 'container'), 'utf8')).replace(/^true/, 'false'))
  assert.equal((await app.ctx.search.status()).managed?.state, 'stopped')
  // The fake SearXNG still answers HTTP, so simulate the outage by searching through ensure directly.
  await app.ctx.search.useManagedSearxng()
  assert.ok((await calls()).includes(`start ${CONTAINER}`))
  await app.stop()
  assert.ok((await calls()).some((c) => c.startsWith(`stop -t 3 ${CONTAINER}`)), 'stopped on shutdown')
})

test('an outdated container image is replaced', async (t) => {
  const { app, dockerDir, sx, calls } = await setup(t)
  await writeFile(join(dockerDir, 'daemon'), '')
  await writeFile(join(dockerDir, 'container'), `true|${sx.port}|searxng/searxng:old`)
  await app.ctx.search.useManagedSearxng()
  const all = await calls()
  assert.ok(all.includes(`rm -f ${CONTAINER}`))
  assert.ok(all.some((c) => c.startsWith('run ')))
})

test('Docker not running and cannot be launched: a clear error; turning off removes the container', async (t) => {
  const { app, dockerDir } = await setup(t)
  assert.equal((await app.ctx.search.status()).managed?.state, 'docker-stopped')
  await assert.rejects(app.ctx.search.search('x'), /could not start its free SearXNG: Docker is not running/)
  await writeFile(join(dockerDir, 'daemon'), '')
  await app.ctx.search.useManagedSearxng()
  await app.ctx.search.disable()
  assert.equal((await app.ctx.search.status()).config, undefined)
  assert.equal((await app.ctx.search.status()).managed?.state, 'not-created')
})

test('choosing another backend leaves managed mode; apps that never started it never stop it', async (t) => {
  const { app, calls } = await setup(t)
  await app.ctx.search.configure({ kind: 'searxng', baseUrl: 'http://127.0.0.1:9' })
  assert.equal((await app.ctx.search.status()).managed, undefined)
  await app.stop()
  assert.ok(!(await calls()).some((c) => c.startsWith('stop')), 'no docker stop for a container this run did not start')
})

test('settings template', () => {
  const yaml = settingsYaml('ab'.repeat(32))
  assert.match(yaml, /use_default_settings: true/)
  assert.match(yaml, /public_instance: false/)
})
