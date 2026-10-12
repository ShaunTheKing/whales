import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, appendFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, type App } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import { describeTree, parseIndex, parseManifest } from '../../src/services/market.ts'
import type { AgentSpec } from '../../src/contracts/core.ts'
import type {} from '../../src/contracts/index.ts'

const REPO = 'https://github.com/acme/whales-plugins'

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()

const pluginSource = (tag: string) => `export default {
  name: 'greeter',
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register({
      spec: { name: 'greet', description: 'greet', inputSchema: { type: 'object', properties: {} } },
      describe: () => null,
      run: async () => ({ output: 'hello ${tag}', isError: false }),
    })
  },
}
`
const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'greeter', version: '1.0.0', description: 'says hello', entry: 'index.js', ...extra })

interface Fixture {
  app: App
  dir: string
  repoDir: string
  commits: string[]
  indexUrl: string
  setIndex(data: unknown): void
}

async function setup(t: { after(fn: () => Promise<void>): void }): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'whales-market-'))
  const repoDir = join(dir, 'remote')
  await mkdir(join(repoDir, 'plugins/greeter'), { recursive: true })
  git(repoDir, 'init', '-q', '-b', 'main')
  await writeFile(join(repoDir, 'plugins/greeter/whales-plugin.json'), manifest())
  await writeFile(join(repoDir, 'plugins/greeter/index.js'), pluginSource('v1'))
  await writeFile(join(repoDir, 'README.md'), 'not part of the plugin')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-q', '-m', 'v1')
  const c1 = git(repoDir, 'rev-parse', 'HEAD')
  await writeFile(join(repoDir, 'plugins/greeter/index.js'), pluginSource('v2'))
  await writeFile(join(repoDir, 'plugins/greeter/whales-plugin.json'), manifest({ version: '2.0.0' }))
  git(repoDir, 'commit', '-q', '-am', 'v2')
  const c2 = git(repoDir, 'rev-parse', 'HEAD')

  let index: unknown = { version: 1, name: 'test', plugins: [{ name: 'greeter', version: '1.0.0', description: 'says hello', repo: REPO, commit: c1, path: 'plugins/greeter' }] }
  const server: Server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/index.json' }).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(index))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const dataDir = join(dir, 'data')
  const app = await createApp({
    config: { ...defaultConfig(), dataDir },
    storePath: join(dir, 'whales.db'),
    services: { checkpoints: false, routines: false, market: { allowHttpIndex: true, repoUrl: (repo) => (repo === REPO ? `file://${repoDir}` : 'file:///nonexistent') } },
  })
  t.after(async () => {
    await app.stop()
    server.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { app, dir, repoDir, commits: [c1, c2], indexUrl: `http://127.0.0.1:${port}/index.json`, setIndex: (data) => (index = data) }
}

const stubAgent = (id: string, plugins: AgentSpec['plugins']): AgentSpec => ({ id, name: id, seniority: 1, driver: { name: 'driver-stub' }, plugins })

test('browse → preview → install → use in an agent; preview shows pinned files only', async (t) => {
  const f = await setup(t)
  const market = f.app.ctx.market
  market.addSource(f.indexUrl)
  const [result] = await market.browse()
  assert.equal(result?.error, undefined)
  assert.deepEqual(result?.entries.map((e) => e.name), ['greeter'])

  const preview = await market.preview({ source: f.indexUrl, name: 'greeter' })
  assert.deepEqual(preview.files.map((x) => x.path), ['index.js', 'whales-plugin.json'])
  assert.equal(preview.manifest.version, '1.0.0')
  assert.deepEqual(preview.origin, { kind: 'github', repo: REPO, commit: f.commits[0], path: 'plugins/greeter', index: f.indexUrl })
  assert.match(preview.digest, /^[0-9a-f]{64}$/)

  const installed = await market.install(preview.id, preview.digest)
  assert.equal(installed.state, 'loaded')
  assert.ok(market.catalog().some((c) => c.name === 'greeter' && c.kind === 'market'))

  const agent = await f.app.ctx.agents.spawn(stubAgent('ann', [{ name: 'greeter' }]))
  const out = await agent.ctx.get('tools')!.forTurn({}).invoke({ id: '1', name: 'greet', input: {} }, new AbortController().signal)
  assert.equal(out.output, 'hello v1')
})

test('the installed bytes are the previewed bytes', async (t) => {
  const f = await setup(t)
  const preview = await f.app.ctx.market.preview({ repo: REPO, commit: f.commits[0]!, path: 'plugins/greeter' })
  await assert.rejects(f.app.ctx.market.install(preview.id, 'f'.repeat(64)), /digest does not match/)
  // Tamper with the staged copy between preview and install.
  const staged = join(f.dir, 'data/plugins/.staging', preview.id, 'index.js')
  await appendFile(staged, '\nconsole.log("evil")\n')
  await assert.rejects(f.app.ctx.market.install(preview.id, preview.digest), /changed since the preview/)
  assert.equal(f.app.ctx.market.list().length, 0)
})

test('pinning: unknown commits, bad repos, paths and index entries are refused', async (t) => {
  const f = await setup(t)
  const market = f.app.ctx.market
  await assert.rejects(market.preview({ repo: REPO, commit: 'a'.repeat(40) }), /failed/)
  await assert.rejects(market.preview({ repo: 'https://evil.example/acme/x', commit: f.commits[0]! }), /github\.com/)
  await assert.rejects(market.preview({ repo: REPO, commit: 'main' }), /40-character/)
  await assert.rejects(market.preview({ repo: REPO, commit: f.commits[0]!, path: '../etc' }), /plain relative/)
  await assert.rejects(market.preview({ repo: REPO, commit: f.commits[0]! }), /no whales-plugin\.json/)
  await assert.rejects(market.preview({ source: f.indexUrl, name: 'nope' }), /not listed/)
  assert.throws(() => market.addSource('ftp://x/index.json'), /https/)
  assert.throws(() => market.addSource('https://user:pw@x/index.json'), /credentials/)
})

test('index redirects are not followed; malformed indexes are reported per source', async (t) => {
  const f = await setup(t)
  const market = f.app.ctx.market
  market.addSource(f.indexUrl.replace('/index.json', '/redirect'))
  market.addSource(f.indexUrl)
  f.setIndex({ version: 2, name: 'x', plugins: [] })
  const results = await market.browse()
  assert.equal(results.length, 2)
  for (const r of results) assert.ok(r.error, `expected an error for ${r.source}`)
  assert.match(results.find((r) => r.source.endsWith('/index.json'))?.error ?? '', /version must be 1/)
})

test('upgrade swaps the catalog entry; uninstall refuses while in use, then removes files', async (t) => {
  const f = await setup(t)
  const market = f.app.ctx.market
  const p1 = await market.preview({ repo: REPO, commit: f.commits[0]!, path: 'plugins/greeter' })
  const v1 = await market.install(p1.id, p1.digest)
  const p2 = await market.preview({ repo: REPO, commit: f.commits[1]!, path: 'plugins/greeter' })
  assert.ok(p2.warnings.some((w) => /replaces installed version 1\.0\.0/.test(w)))
  const v2 = await market.install(p2.id, p2.digest)
  assert.equal(v2.manifest.version, '2.0.0')
  assert.ok(!existsSync(v1.dir), 'old version folder removed')

  const agent = await f.app.ctx.agents.spawn(stubAgent('ann', [{ name: 'greeter' }]))
  const out = await agent.ctx.get('tools')!.forTurn({}).invoke({ id: '1', name: 'greet', input: {} }, new AbortController().signal)
  assert.equal(out.output, 'hello v2')

  await assert.rejects(market.uninstall('greeter'), /still used by agent ann/)
  await f.app.ctx.agents.update(stubAgent('ann', []))
  assert.equal(await market.uninstall('greeter'), true)
  assert.ok(!existsSync(v2.dir))
  assert.equal(f.app.ctx.agents.catalog.resolve('greeter'), undefined)
  assert.equal(await market.uninstall('greeter'), false)
})

test('built-in names cannot be taken; broken plugins do not install', async (t) => {
  const f = await setup(t)
  const local = join(f.dir, 'local')
  await mkdir(local)
  await writeFile(join(local, 'whales-plugin.json'), JSON.stringify({ name: 'memory', version: '1', description: 'x', entry: 'index.js' }))
  await writeFile(join(local, 'index.js'), 'export default { apply() {} }')
  await assert.rejects(f.app.ctx.market.preview({ local }), /built-in/)

  await writeFile(join(local, 'whales-plugin.json'), JSON.stringify({ name: 'broken', version: '1', description: 'x', entry: 'index.js' }))
  await writeFile(join(local, 'index.js'), 'export default 42')
  const p = await f.app.ctx.market.preview({ local })
  assert.ok(p.warnings.some((w) => /local folder/.test(w)))
  await assert.rejects(f.app.ctx.market.install(p.id, p.digest), /export default/)
  assert.equal(f.app.ctx.market.list().length, 0)
  assert.ok(!existsSync(join(f.dir, 'data/plugins/broken', p.digest.slice(0, 16))))
})

test('local folders: symlinks are refused, entry must stay inside', async (t) => {
  const f = await setup(t)
  const local = join(f.dir, 'local')
  await mkdir(local)
  await writeFile(join(local, 'whales-plugin.json'), manifest())
  await writeFile(join(local, 'index.js'), pluginSource('local'))
  await symlink('/etc/passwd', join(local, 'passwd'))
  await assert.rejects(f.app.ctx.market.preview({ local }), /symlink/)
  await rm(join(local, 'passwd'))
  await writeFile(join(local, 'whales-plugin.json'), manifest({ entry: '../../outside.js' }))
  await assert.rejects(f.app.ctx.market.preview({ local }), /relative path inside/)
  await assert.rejects(f.app.ctx.market.preview({ local: 'relative/path' }), /absolute/)
})

test('installed plugins load on restart; tampered files are refused at load', async (t) => {
  const f = await setup(t)
  const p = await f.app.ctx.market.preview({ repo: REPO, commit: f.commits[0]!, path: 'plugins/greeter' })
  const installed = await f.app.ctx.market.install(p.id, p.digest)
  await f.app.ctx.agents.spawn(stubAgent('ann', [{ name: 'greeter' }]))
  await f.app.stop()

  const options = { config: { ...defaultConfig(), dataDir: join(f.dir, 'data') }, storePath: join(f.dir, 'whales.db'), services: { checkpoints: false as const, routines: false as const } }
  const again = await createApp(options)
  try {
    assert.equal(again.ctx.market.list()[0]?.state, 'loaded')
    const restored = await again.ctx.agents.restore()
    assert.deepEqual(restored.ok, ['ann'])
  } finally {
    await again.stop()
  }

  await appendFile(join(installed.dir, 'index.js'), '\n// changed on disk\n')
  const third = await createApp(options)
  try {
    const view = third.ctx.market.list()[0]
    assert.equal(view?.state, 'failed')
    assert.match(view?.error ?? '', /modified after install/)
    assert.equal(third.ctx.agents.catalog.resolve('greeter'), undefined)
  } finally {
    await third.stop()
  }
  // Re-stopping the original app in t.after must be harmless.
})

test('parsers', async () => {
  assert.throws(() => parseIndex({ version: 1, name: 'x', plugins: [{ name: 'A', version: '1', description: 'd', repo: REPO, commit: 'a'.repeat(40) }] }), /valid plugin name/)
  assert.throws(() => parseIndex({ version: 1, name: 'x', plugins: [{ name: 'ab', version: '1', description: 'd', repo: REPO, commit: 'a'.repeat(40), homepage: 'http://x' }] }), /https/)
  const twice = { name: 'ab', version: '1', description: 'd', repo: REPO, commit: 'a'.repeat(40) }
  assert.throws(() => parseIndex({ version: 1, name: 'x', plugins: [twice, twice] }), /twice/)
  assert.equal(parseIndex({ version: 1, name: 'x', plugins: [{ ...twice, repo: `${REPO}.git` }] }).plugins[0]?.repo, REPO)
  assert.throws(() => parseManifest('{"name":"ab","version":"1","description":"d","entry":"/abs.js"}'), /relative/)
  assert.throws(() => parseManifest('{"name":"ab","version":"1","description":"d","entry":"x.sh"}'), /\.js/)
  assert.throws(() => parseManifest('nope'), /JSON/)
})

test('describeTree: digest covers names and contents', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'whales-tree-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'a'), 'x')
  const one = await describeTree(dir)
  await writeFile(join(dir, 'a'), 'y')
  const two = await describeTree(dir)
  await rm(join(dir, 'a'))
  await writeFile(join(dir, 'b'), 'y')
  const three = await describeTree(dir)
  assert.equal(new Set([one.digest, two.digest, three.digest]).size, 3)
  assert.equal((await readFile(join(dir, 'b'), 'utf8')), 'y')
})

test('bundled example plugins install from their folders and register their tools', async (t) => {
  const f = await setup(t)
  const root = join(import.meta.dirname, '../../plugins')
  for (const name of ['dice', 'deepseek-delegate', 'web-fetch']) {
    const p = await f.app.ctx.market.preview({ local: join(root, name) })
    assert.deepEqual(p.warnings, ['installed from a local folder: no commit pin, the digest is the only identity'])
    await f.app.ctx.market.install(p.id, p.digest)
  }
  const agent = await f.app.ctx.agents.spawn(stubAgent('ann', [{ name: 'dice', config: { sides: 2 } }, { name: 'deepseek-delegate' }, { name: 'web-fetch' }]))
  const tools = agent.ctx.get('tools')!
  assert.deepEqual(tools.list().map((s) => s.name).sort(), ['delegate_to_deepseek', 'roll_dice', 'web_fetch'])
  const roll = await tools.forTurn({}).invoke({ id: '1', name: 'roll_dice', input: { count: 3 } }, new AbortController().signal)
  assert.match(roll.output, /^[12], [12], [12] \(total [3-6]\)$/)
  // Network tools need approval: with nobody answering in this test, a strict agent's call is not run.
  const ds = await tools.forTurn({}).invoke({ id: '2', name: 'web_fetch', input: { url: 'ftp://x' } }, AbortSignal.timeout(200))
  assert.equal(ds.isError, true)
})
