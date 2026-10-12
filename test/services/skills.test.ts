import { test, after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Service, type Context } from 'cordis'
import { createApp } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import { SkillLibrary, parseSkill, SkillParseError } from '../../src/services/skills.ts'
import type {} from '../../src/contracts/skills.ts'
import type {} from '../../src/contracts/agents.ts'
import type {} from '../../src/contracts/driver.ts'
import type { Driver, DriverEvent, TurnInput } from '../../src/contracts/driver.ts'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = []

function makeTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'whales-skills-'))
  tmpDirs.push(dir)
  return dir
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

function skillFile(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`
}

/** Write a skill directory by hand (bypassing install). */
function writeSkillDir(dir: string, dirName: string, content: string): void {
  const d = path.join(dir, dirName)
  mkdirSync(d, { recursive: true })
  writeFileSync(path.join(d, 'SKILL.md'), content)
}

// ---------------------------------------------------------------------------
// spy driver
// ---------------------------------------------------------------------------

const spyInputs: TurnInput[] = []

class SpyDriver extends Service implements Driver {
  static inject: string[] = []
  readonly kind = 'spy'
  readonly model = 'spy'
  readonly capabilities = { tools: false, agentic: false, statefulSession: false }

  constructor(ctx: Context) {
    super(ctx, 'driver')
  }

  async *run(input: TurnInput, _signal: AbortSignal): AsyncIterable<DriverEvent> {
    spyInputs.push(input)
    yield { type: 'text', delta: 'ok' }
    yield { type: 'done', stopReason: 'end' }
  }
}

// ---------------------------------------------------------------------------
// http server
// ---------------------------------------------------------------------------

let server: Server | undefined
let serverPort = 0
let flipRequests = 0

const GOOD_SKILL = skillFile('remote-skill', 'A remote skill.', 'Remote body.')

function startServer(): Promise<void> {
  // One shared server for the file; it is closed in after().
  if (server) return Promise.resolve()
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const url = req.url ?? '/'
      if (url === '/SKILL.md') {
        res.writeHead(200, { 'content-type': 'text/markdown' })
        res.end(GOOD_SKILL)
        return
      }
      if (url === '/flip.md') {
        // Serves the genuine skill twice, then different content: models a source that changes mid-install.
        flipRequests++
        res.writeHead(200, { 'content-type': 'text/markdown' })
        res.end(flipRequests <= 2 ? GOOD_SKILL : GOOD_SKILL.replace(/\n---\n[\s\S]*$/, '\n---\nSWAPPED BODY'))
        return
      }
      if (url === '/oversize.md') {
        const big = 'x'.repeat(5000)
        res.writeHead(200, { 'content-type': 'text/markdown' })
        res.end(big)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    })
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      if (addr && typeof addr === 'object') serverPort = addr.port
      server = s
      resolve()
    })
  })
}

// ---------------------------------------------------------------------------
// app lifecycle
// ---------------------------------------------------------------------------

let app: Awaited<ReturnType<typeof createApp>> | undefined
let dataDir = ''

async function makeApp(skills?: { dir?: string; maxBytes?: number }): Promise<Awaited<ReturnType<typeof createApp>>> {
  dataDir = makeTmp()
  // The skills dir lives inside the fresh data dir; compute it only after dataDir is set.
  const config = { dir: skillsDir(), ...skills }
  const a = await createApp({
    config: defaultConfig({ env: {}, home: dataDir, cwd: dataDir }),
    storePath: ':memory:',
    services: { skills: config },
  })
  app = a
  return a
}

function skillsDir(): string {
  return path.join(dataDir, 'skills')
}

function getLibrary(a: Awaited<ReturnType<typeof createApp>>): SkillLibrary {
  const svc = a.ctx.get('skills')
  assert.ok(svc instanceof SkillLibrary, 'skills service should be a SkillLibrary')
  return svc
}

beforeEach(() => {
  spyInputs.length = 0
})

afterEach(async () => {
  if (app) {
    await app.stop()
    app = undefined
  }
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

after(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  }
})

// ---------------------------------------------------------------------------
// parseSkill
// ---------------------------------------------------------------------------

test('parseSkill: valid file', () => {
  const parsed = parseSkill(skillFile('code-review', 'Reviews code.', 'Body line.'))
  assert.equal(parsed.name, 'code-review')
  assert.equal(parsed.description, 'Reviews code.')
  assert.equal(parsed.body, 'Body line.')
})

test('parseSkill: CRLF normalised', () => {
  const text = '---\r\nname: code-review\r\ndescription: Reviews code.\r\n---\r\nBody line.\r\n'
  const parsed = parseSkill(text)
  assert.equal(parsed.name, 'code-review')
  assert.equal(parsed.description, 'Reviews code.')
  assert.equal(parsed.body, 'Body line.')
})

test('parseSkill: empty body ok', () => {
  const parsed = parseSkill('---\nname: empty-body\ndescription: No body.\n---\n')
  assert.equal(parsed.name, 'empty-body')
  assert.equal(parsed.body, '')
})

test('parseSkill: comments and blank lines ignored', () => {
  const text = '---\n# a comment\n\nname: commented\ndescription: Has comments.\n---\nbody'
  const parsed = parseSkill(text)
  assert.equal(parsed.name, 'commented')
  assert.equal(parsed.description, 'Has comments.')
})

test('parseSkill: unknown keys ignored', () => {
  const text = '---\nname: unknown-keys\ndescription: Fine.\nversion: 3\nauthor: someone\n---\nbody'
  const parsed = parseSkill(text)
  assert.equal(parsed.name, 'unknown-keys')
  assert.equal(parsed.description, 'Fine.')
})

test('parseSkill: missing opening ---', () => {
  assert.throws(() => parseSkill('name: x\ndescription: y\n---\nbody'), SkillParseError)
})

test('parseSkill: missing closing ---', () => {
  assert.throws(() => parseSkill('---\nname: x\ndescription: y\nbody'), SkillParseError)
})

test('parseSkill: missing name', () => {
  assert.throws(() => parseSkill('---\ndescription: y\n---\nbody'), SkillParseError)
})

test('parseSkill: invalid name "Bad Name"', () => {
  assert.throws(() => parseSkill(skillFile('Bad Name', 'desc', 'body')), SkillParseError)
})

test('parseSkill: invalid name "../evil"', () => {
  assert.throws(() => parseSkill(skillFile('../evil', 'desc', 'body')), SkillParseError)
})

test('parseSkill: missing description', () => {
  assert.throws(() => parseSkill('---\nname: no-desc\n---\nbody'), SkillParseError)
})

test('parseSkill: empty description', () => {
  assert.throws(() => parseSkill('---\nname: empty-desc\ndescription:\n---\nbody'), SkillParseError)
})

test('parseSkill: 301-char description', () => {
  const long = 'a'.repeat(301)
  assert.throws(() => parseSkill(skillFile('long-desc', long, 'body')), SkillParseError)
})

test('parseSkill: non key:value line in front matter', () => {
  assert.throws(() => parseSkill('---\nname: x\nthis is not a pair\ndescription: y\n---\nbody'), SkillParseError)
})

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

test('list(): missing dir → []', async () => {
  const a = await makeApp({ dir: path.join(makeTmp(), 'does-not-exist') })
  const lib = getLibrary(a)
  assert.deepEqual(await lib.list(), [])
})

test('list(): installed skills sorted by name', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  writeSkillDir(skillsDir(), 'zeta', skillFile('zeta', 'Z.', 'z'))
  writeSkillDir(skillsDir(), 'alpha', skillFile('alpha', 'A.', 'a'))
  writeSkillDir(skillsDir(), 'mid', skillFile('mid', 'M.', 'm'))
  const list = await lib.list()
  assert.deepEqual(
    list.map((s) => s.name),
    ['alpha', 'mid', 'zeta'],
  )
})

test('list(): skips invalid, missing, unparseable and mismatched dirs', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  writeSkillDir(skillsDir(), 'good', skillFile('good', 'Good.', 'g'))
  // invalid directory name
  writeSkillDir(skillsDir(), 'Bad Name', skillFile('Bad Name', 'Bad.', 'b'))
  // directory without SKILL.md
  mkdirSync(path.join(skillsDir(), 'no-file'), { recursive: true })
  // unparseable SKILL.md
  writeSkillDir(skillsDir(), 'broken', 'not a skill at all')
  // front-matter name differs from directory name
  writeSkillDir(skillsDir(), 'mismatch', skillFile('other-name', 'Mismatch.', 'm'))
  const list = await lib.list()
  assert.deepEqual(
    list.map((s) => s.name),
    ['good'],
  )
})

// ---------------------------------------------------------------------------
// read()
// ---------------------------------------------------------------------------

test('read(): valid skill', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  writeSkillDir(skillsDir(), 'reader', skillFile('reader', 'Reads.', 'the body'))
  const skill = await lib.read('reader')
  assert.ok(skill)
  assert.equal(skill.name, 'reader')
  assert.equal(skill.description, 'Reads.')
  assert.equal(skill.body, 'the body')
  assert.ok(path.isAbsolute(skill.path))
  assert.ok(skill.path.endsWith('SKILL.md'))
})

test('read(): missing → undefined', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  assert.equal(await lib.read('nope'), undefined)
})

test('read(): invalid names → undefined', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  assert.equal(await lib.read('../x'), undefined)
  assert.equal(await lib.read('A'), undefined)
  assert.equal(await lib.read(''), undefined)
})

// ---------------------------------------------------------------------------
// preview() local
// ---------------------------------------------------------------------------

test('preview(local file): fields, hash, writes nothing', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  const srcDir = makeTmp()
  const file = path.join(srcDir, 'SKILL.md')
  const content = skillFile('local-file', 'From a file.', 'file body')
  writeFileSync(file, content)

  const preview = await lib.preview(file)
  assert.equal(preview.name, 'local-file')
  assert.equal(preview.description, 'From a file.')
  assert.equal(preview.body, 'file body')
  assert.equal(preview.source, file)
  assert.equal(preview.hash, sha256Hex(content))
  assert.equal(preview.existing, undefined)
  assert.equal(await lib.read('local-file'), undefined)
  assert.ok(!existsSync(path.join(skillsDir(), 'local-file')))
})

test('preview(local directory): reads SKILL.md inside', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  const srcDir = makeTmp()
  const content = skillFile('local-dir', 'From a dir.', 'dir body')
  writeFileSync(path.join(srcDir, 'SKILL.md'), content)

  const preview = await lib.preview(srcDir)
  assert.equal(preview.name, 'local-dir')
  assert.equal(preview.description, 'From a dir.')
  assert.equal(preview.body, 'dir body')
  assert.equal(preview.hash, sha256Hex(content))
})

test('preview: existing present when same-name skill installed', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  writeSkillDir(skillsDir(), 'dup', skillFile('dup', 'Old.', 'old body'))
  const srcDir = makeTmp()
  const file = path.join(srcDir, 'SKILL.md')
  writeFileSync(file, skillFile('dup', 'New.', 'new body'))

  const preview = await lib.preview(file)
  assert.ok(preview.existing)
  assert.equal(preview.existing.name, 'dup')
  assert.equal(preview.existing.description, 'Old.')
})

// ---------------------------------------------------------------------------
// preview() rejections
// ---------------------------------------------------------------------------

test('preview: relative path rejected', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  await assert.rejects(lib.preview('skills/x'), (err: Error) => {
    assert.match(err.message, /absolute/)
    return true
  })
})

test('preview: http:// non-local rejected mentioning https', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  await assert.rejects(lib.preview('http://example.com/x'), (err: Error) => {
    assert.match(err.message, /https/)
    return true
  })
})

test('preview: oversize local file rejected', async () => {
  const a = await makeApp({ maxBytes: 100 })
  const lib = getLibrary(a)
  const srcDir = makeTmp()
  const file = path.join(srcDir, 'SKILL.md')
  writeFileSync(file, skillFile('big', 'Big.', 'x'.repeat(500)))
  await assert.rejects(lib.preview(file), (err: Error) => {
    assert.match(err.message, /100|limit|large|size/i)
    return true
  })
})

test('preview: unparseable content → SkillParseError', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  const srcDir = makeTmp()
  const file = path.join(srcDir, 'SKILL.md')
  writeFileSync(file, 'no front matter here')
  await assert.rejects(lib.preview(file), SkillParseError)
})

// ---------------------------------------------------------------------------
// preview() http
// ---------------------------------------------------------------------------

test('preview(http://127.0.0.1): works', async () => {
  await startServer()
  const a = await makeApp()
  const lib = getLibrary(a)
  const url = `http://127.0.0.1:${serverPort}/SKILL.md`
  const preview = await lib.preview(url)
  assert.equal(preview.name, 'remote-skill')
  assert.equal(preview.description, 'A remote skill.')
  assert.equal(preview.body, 'Remote body.')
  assert.equal(preview.source, url)
  assert.equal(preview.hash, sha256Hex(GOOD_SKILL))
})

test('preview(http): 404 rejected', async () => {
  await startServer()
  const a = await makeApp()
  const lib = getLibrary(a)
  await assert.rejects(lib.preview(`http://127.0.0.1:${serverPort}/missing.md`), (err: Error) => {
    assert.match(err.message, /404/)
    return true
  })
})

test('preview(http): oversize rejected', async () => {
  await startServer()
  const a = await makeApp({ maxBytes: 100 })
  const lib = getLibrary(a)
  await assert.rejects(lib.preview(`http://127.0.0.1:${serverPort}/oversize.md`), (err: Error) => {
    assert.match(err.message, /100|limit|large|size/i)
    return true
  })
})

// ---------------------------------------------------------------------------
// install()
// ---------------------------------------------------------------------------

test('install: wrong hash rejected, nothing written', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  const srcDir = makeTmp()
  const file = path.join(srcDir, 'SKILL.md')
  writeFileSync(file, skillFile('wrong-hash', 'W.', 'w'))
  await assert.rejects(lib.install(file, 'deadbeef'), (err: Error) => {
    assert.match(err.message, /changed/)
    return true
  })
  assert.ok(!existsSync(path.join(skillsDir(), 'wrong-hash')))
})

test('install: correct hash writes file, read/list/record', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  const srcDir = makeTmp()
  const file = path.join(srcDir, 'SKILL.md')
  const content = skillFile('installed', 'Installed.', 'installed body')
  writeFileSync(file, content)
  const preview = await lib.preview(file)

  const skill = await lib.install(file, preview.hash)
  assert.equal(skill.name, 'installed')
  assert.equal(skill.description, 'Installed.')
  assert.equal(skill.body, 'installed body')

  const target = path.join(skillsDir(), 'installed', 'SKILL.md')
  assert.ok(existsSync(target))
  assert.equal(readFileSync(target, 'utf8'), content)

  const read = await lib.read('installed')
  assert.ok(read)
  assert.equal(read.body, 'installed body')

  const list = await lib.list()
  assert.ok(list.some((s) => s.name === 'installed'))

  const records = await a.ctx.store.collection('skillInstalls').list()
  const rec = records.find((r) => r.name === 'installed')
  assert.ok(rec)
  assert.equal(rec.source, file)
  assert.equal(rec.hash, preview.hash)
})

test('install: source modified between preview and install → changed', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  const srcDir = makeTmp()
  const file = path.join(srcDir, 'SKILL.md')
  writeFileSync(file, skillFile('modified', 'First.', 'first'))
  const preview = await lib.preview(file)
  writeFileSync(file, skillFile('modified', 'Second.', 'second'))
  await assert.rejects(lib.install(file, preview.hash), (err: Error) => {
    assert.match(err.message, /changed/)
    return true
  })
})

test('install: installing again replaces content', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  const srcDir = makeTmp()
  const file = path.join(srcDir, 'SKILL.md')
  writeFileSync(file, skillFile('replace', 'One.', 'one'))
  const p1 = await lib.preview(file)
  await lib.install(file, p1.hash)

  writeFileSync(file, skillFile('replace', 'Two.', 'two'))
  const p2 = await lib.preview(file)
  await lib.install(file, p2.hash)

  const read = await lib.read('replace')
  assert.ok(read)
  assert.equal(read.description, 'Two.')
  assert.equal(read.body, 'two')
})

test('install: "../evil" name cannot be installed, nothing outside dir', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  const srcDir = makeTmp()
  const file = path.join(srcDir, 'SKILL.md')
  writeFileSync(file, skillFile('../evil', 'Evil.', 'evil'))
  await assert.rejects(lib.preview(file), SkillParseError)
  assert.ok(!existsSync(path.join(dataDir, 'evil')))
})

test('install: no leftover .tmp files', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  const srcDir = makeTmp()
  const file = path.join(srcDir, 'SKILL.md')
  writeFileSync(file, skillFile('clean', 'Clean.', 'clean'))
  const preview = await lib.preview(file)
  await lib.install(file, preview.hash)
  const entries = readdirSync(path.join(skillsDir(), 'clean'))
  assert.ok(!entries.some((e) => e.includes('.tmp')))
})

// ---------------------------------------------------------------------------
// remove()
// ---------------------------------------------------------------------------

test('remove(): true then false, directory gone', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  const srcDir = makeTmp()
  const file = path.join(srcDir, 'SKILL.md')
  writeFileSync(file, skillFile('removable', 'R.', 'r'))
  const preview = await lib.preview(file)
  await lib.install(file, preview.hash)

  assert.equal(await lib.remove('removable'), true)
  assert.ok(!existsSync(path.join(skillsDir(), 'removable')))
  assert.equal(await lib.remove('removable'), false)
})

test('remove(): invalid name → false', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  assert.equal(await lib.remove('../x'), false)
  assert.equal(await lib.remove('Bad Name'), false)
})

// ---------------------------------------------------------------------------
// per-agent plugin
// ---------------------------------------------------------------------------

async function spawnWithSkills(
  a: Awaited<ReturnType<typeof createApp>>,
  id: string,
  config: Record<string, unknown> | undefined,
): Promise<Awaited<ReturnType<typeof a.ctx.agents.spawn>>> {
  a.ctx.agents.catalog.register('driver-spy', SpyDriver)
  return a.ctx.agents.spawn(
    {
      id,
      name: id,
      seniority: 1,
      driver: { name: 'driver-spy', config: {} },
      plugins: [{ name: 'skills', config }],
    },
    { persist: false },
  )
}

test('agent skills: prompt section includes installed skill', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  const srcDir = makeTmp()
  const file = path.join(srcDir, 'SKILL.md')
  writeFileSync(file, skillFile('alpha', 'Alpha description.', 'Alpha body.'))
  const preview = await lib.preview(file)
  await lib.install(file, preview.hash)

  const handle = await spawnWithSkills(a, 'agent-alpha', { names: ['alpha'] })
  assert.ok(handle.runtime)
  for await (const _ev of handle.runtime.turn('hi')) {
    // drain
  }
  const input = spyInputs.at(-1)
  assert.ok(input)
  assert.match(input.system, /## Skill: alpha/)
  assert.match(input.system, /Alpha description\./)
  assert.match(input.system, /Alpha body\./)
})

test('agent skills: missing skill silently skipped, turn ok', async () => {
  const a = await makeApp()
  const handle = await spawnWithSkills(a, 'agent-missing', { names: ['missing-one'] })
  assert.ok(handle.runtime)
  let sawDone = false
  for await (const ev of handle.runtime.turn('hi')) {
    if (ev.type === 'done') sawDone = true
  }
  assert.ok(sawDone)
  const input = spyInputs.at(-1)
  assert.ok(input)
  assert.ok(!input.system.includes('## Skill: missing-one'))
})

test('agent skills: names order respected', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  const srcDir = makeTmp()
  for (const n of ['first', 'second']) {
    const file = path.join(srcDir, `${n}.md`)
    writeFileSync(file, skillFile(n, `${n} desc.`, `${n} body.`))
    const preview = await lib.preview(file)
    await lib.install(file, preview.hash)
  }

  const handle = await spawnWithSkills(a, 'agent-order', { names: ['second', 'first'] })
  assert.ok(handle.runtime)
  for await (const _ev of handle.runtime.turn('hi')) {
    // drain
  }
  const input = spyInputs.at(-1)
  assert.ok(input)
  const idxSecond = input.system.indexOf('## Skill: second')
  const idxFirst = input.system.indexOf('## Skill: first')
  assert.ok(idxSecond >= 0)
  assert.ok(idxFirst >= 0)
  assert.ok(idxSecond < idxFirst)
})

test('agent skills: invalid config names rejected', async () => {
  const a = await makeApp()
  a.ctx.agents.catalog.register('driver-spy', SpyDriver)
  await assert.rejects(
    Promise.resolve(
      a.ctx.agents.spawn(
        {
          id: 'agent-bad',
          name: 'agent-bad',
          seniority: 1,
          driver: { name: 'driver-spy', config: {} },
          plugins: [{ name: 'skills', config: { names: ['Bad Name'] } }],
        },
        { persist: false },
      ),
    ),
  )
})

test('agent skills: non-array names rejected', async () => {
  const a = await makeApp()
  a.ctx.agents.catalog.register('driver-spy', SpyDriver)
  await assert.rejects(
    Promise.resolve(
      a.ctx.agents.spawn(
        {
          id: 'agent-bad2',
          name: 'agent-bad2',
          seniority: 1,
          driver: { name: 'driver-spy', config: {} },
          plugins: [{ name: 'skills', config: { names: 'x' } }],
        },
        { persist: false },
      ),
    ),
  )
})

test('agent skills: config omitted spawns with no skills section', async () => {
  const a = await makeApp()
  a.ctx.agents.catalog.register('driver-spy', SpyDriver)
  const handle = await a.ctx.agents.spawn(
    {
      id: 'agent-none',
      name: 'agent-none',
      seniority: 1,
      driver: { name: 'driver-spy', config: {} },
      plugins: [{ name: 'skills', config: {} }],
    },
    { persist: false },
  )
  assert.ok(handle.runtime)
  for await (const _ev of handle.runtime.turn('hi')) {
    // drain
  }
  const input = spyInputs.at(-1)
  assert.ok(input)
  assert.ok(!input.system.includes('## Skill:'))
})

test('install: writes exactly the bytes whose hash was verified (no second fetch)', async () => {
  const a = await makeApp()
  const lib = getLibrary(a)
  await startServer()
  flipRequests = 0
  const source = `http://127.0.0.1:${serverPort}/flip.md`
  const preview = await lib.preview(source)
  const installed = await lib.install(source, preview.hash)
  assert.equal(installed.body, preview.body)
  assert.ok(!readFileSync(installed.path, 'utf8').includes('SWAPPED BODY'))
})
