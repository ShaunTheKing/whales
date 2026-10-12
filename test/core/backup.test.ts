import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import { createBackup, readBackup, restoreBackup } from '../../src/core/backup.ts'
import type {} from '../../src/contracts/index.ts'

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function countRegularFiles(dir: string): number {
  let n = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const st = fs.lstatSync(full)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) n += countRegularFiles(full)
    else if (st.isFile()) n += 1
  }
  return n
}

interface Fixture {
  tmp: string
  dataDir: string
  outside: string
  app: Awaited<ReturnType<typeof createApp>>
  symlinkOk: boolean
}

async function setup(): Promise<Fixture> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whales-backup-'))
  const dataDir = path.join(tmp, 'data')
  const outside = path.join(tmp, 'outside')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n')
  const config = defaultConfig({ env: { WHALES_DATA_DIR: dataDir }, home: tmp, cwd: tmp })
  const app = await createApp({ config, storePath: path.join(dataDir, 'whales.db') })
  await app.ctx.agents.spawn({ id: 'a1', name: 'A', seniority: 1, driver: { name: 'driver-stub' }, plugins: [] })
  app.ctx.get('rules')?.add('deny running commands matching rm *')
  fs.mkdirSync(path.join(dataDir, 'workspaces', 'a1', 'notes'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'workspaces', 'a1', 'notes', 'n.md'), 'note body\n')
  fs.mkdirSync(path.join(dataDir, 'skills', 's1'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'skills', 's1', 'SKILL.md'), 'skill body\n')
  let symlinkOk = true
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dataDir, 'workspaces', 'a1', 'link'))
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EPERM') symlinkOk = false
    else throw err
  }
  fs.writeFileSync(path.join(dataDir, '.env'), 'SECRET=1\n')
  fs.writeFileSync(path.join(dataDir, 'whales.config.json'), '{}\n')
  return { tmp, dataDir, outside, app, symlinkOk }
}

async function teardown(fx: Fixture): Promise<void> {
  await fx.app.stop()
  fs.rmSync(fx.tmp, { recursive: true, force: true })
}

test('createBackup writes a complete backup', async () => {
  const fx = await setup()
  try {
    const outRoot = path.join(fx.tmp, 'backups')
    const { dir, manifest } = await createBackup(fx.app, outRoot)
    assert.ok(dir.startsWith(outRoot + path.sep))
    assert.match(path.basename(dir), /^whales-backup-\d{8}-\d{6}$/)
    assert.equal(manifest.format, 'whales-backup')
    assert.equal(manifest.version, 1)
    assert.equal(manifest.database.file, 'whales.db')
    assert.equal(manifest.database.sha256, sha256(path.join(dir, 'whales.db')))
    assert.equal(manifest.database.bytes, fs.statSync(path.join(dir, 'whales.db')).size)
    assert.ok(manifest.directories.includes('workspaces'))
    assert.ok(manifest.directories.includes('skills'))
    assert.ok(!manifest.directories.includes('checkpoints'))
    const expectedFiles =
      countRegularFiles(path.join(fx.dataDir, 'workspaces')) +
      countRegularFiles(path.join(fx.dataDir, 'skills')) +
      1 // whales.config.json
    assert.equal(manifest.files, expectedFiles)

    const manifestOnDisk = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as unknown
    assert.deepEqual(manifestOnDisk, manifest)

    const db = new DatabaseSync(path.join(dir, 'whales.db'), { readOnly: true })
    try {
      const agent = db.prepare('SELECT id FROM records WHERE collection = ? AND id = ?').get('agents', 'a1')
      assert.ok(agent, 'agent record present in backup db')
      const rule = db.prepare('SELECT id FROM records WHERE collection = ?').all('rules')
      assert.ok(rule.length >= 1, 'rule record present in backup db')
    } finally {
      db.close()
    }

    if (fx.symlinkOk) {
      const link = path.join(dir, 'workspaces', 'a1', 'link')
      assert.ok(fs.lstatSync(link).isSymbolicLink(), 'symlink copied as symlink')
      assert.ok(!fs.existsSync(path.join(dir, 'workspaces', 'a1', 'secret.txt')))
      assert.ok(!fs.existsSync(path.join(dir, 'secret.txt')))
    }
    assert.ok(!fs.existsSync(path.join(dir, '.env')))
    assert.ok(fs.existsSync(path.join(dir, 'whales.config.json')))
    assert.ok(!fs.existsSync(path.join(dir, 'whales.db-wal')))
    assert.ok(!fs.existsSync(path.join(dir, 'whales.db-shm')))
  } finally {
    await teardown(fx)
  }
})

test('createBackup rejects relative outRoot and outRoot inside data dir', async () => {
  const fx = await setup()
  try {
    await assert.rejects(() => createBackup(fx.app, 'relative/backups'), TypeError)
    await assert.rejects(
      () => createBackup(fx.app, path.join(fx.dataDir, 'backups')),
      /outside the data dir/,
    )
  } finally {
    await teardown(fx)
  }
})

test('two backups in the same second get distinct dirs', async () => {
  const fx = await setup()
  try {
    const outRoot = path.join(fx.tmp, 'backups')
    const first = await createBackup(fx.app, outRoot)
    const second = await createBackup(fx.app, outRoot)
    assert.notEqual(first.dir, second.dir)
    assert.ok(fs.existsSync(path.join(first.dir, 'manifest.json')))
    assert.ok(fs.existsSync(path.join(second.dir, 'manifest.json')))
  } finally {
    await teardown(fx)
  }
})

test('readBackup validates a backup dir', async () => {
  const fx = await setup()
  try {
    const outRoot = path.join(fx.tmp, 'backups')
    const { dir, manifest } = await createBackup(fx.app, outRoot)
    const read = await readBackup(dir)
    assert.deepEqual(read, manifest)

    await assert.rejects(() => readBackup(path.join(fx.tmp, 'nope')), /manifest/)

    const tampered = path.join(fx.tmp, 'tampered')
    fs.cpSync(dir, tampered, { recursive: true })
    fs.appendFileSync(path.join(tampered, 'whales.db'), 'x')
    await assert.rejects(() => readBackup(tampered), /checksum/)

    const badFormat = path.join(fx.tmp, 'bad-format')
    fs.cpSync(dir, badFormat, { recursive: true })
    const mf = JSON.parse(fs.readFileSync(path.join(badFormat, 'manifest.json'), 'utf8')) as Record<string, unknown>
    mf.format = 'other'
    fs.writeFileSync(path.join(badFormat, 'manifest.json'), JSON.stringify(mf, null, 2))
    await assert.rejects(() => readBackup(badFormat))

    const missingDir = path.join(fx.tmp, 'missing-dir')
    fs.cpSync(dir, missingDir, { recursive: true })
    const mf2 = JSON.parse(fs.readFileSync(path.join(missingDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    mf2.directories = ['workspaces', 'skills', 'checkpoints']
    fs.writeFileSync(path.join(missingDir, 'manifest.json'), JSON.stringify(mf2, null, 2))
    await assert.rejects(() => readBackup(missingDir))
  } finally {
    await teardown(fx)
  }
})

test('restoreBackup into an empty data dir', async () => {
  const fx = await setup()
  let restored: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const outRoot = path.join(fx.tmp, 'backups')
    const { dir, manifest } = await createBackup(fx.app, outRoot)
    await fx.app.stop()

    const target = path.join(fx.tmp, 'restored')
    const result = await restoreBackup(dir, target)
    assert.deepEqual(result, manifest)
    assert.ok(fs.existsSync(path.join(target, 'whales.db')))
    assert.ok(fs.existsSync(path.join(target, 'whales.config.json')))
    assert.equal(
      fs.readFileSync(path.join(target, 'workspaces', 'a1', 'notes', 'n.md'), 'utf8'),
      'note body\n',
    )
    assert.equal(fs.readFileSync(path.join(target, 'skills', 's1', 'SKILL.md'), 'utf8'), 'skill body\n')

    const config = defaultConfig({ env: { WHALES_DATA_DIR: target }, home: fx.tmp, cwd: fx.tmp })
    restored = await createApp({ config, storePath: path.join(target, 'whales.db') })
    const agents = restored.ctx.store.collection('agents')
    assert.ok(agents.get('a1'))
    const rules = restored.ctx.get('rules')
    assert.ok(rules)
    assert.ok(rules.list().length >= 1)
  } finally {
    if (restored) await restored.stop()
    await teardown(fx)
  }
})

test('restoreBackup refuses without force and moves files aside with force', async () => {
  const fx = await setup()
  try {
    const outRoot = path.join(fx.tmp, 'backups')
    const { dir } = await createBackup(fx.app, outRoot)

    await assert.rejects(() => restoreBackup(dir, fx.dataDir), /--force/)
    assert.ok(fs.existsSync(path.join(fx.dataDir, 'whales.db')))
    assert.equal(fs.readFileSync(path.join(fx.dataDir, 'workspaces', 'a1', 'notes', 'n.md'), 'utf8'), 'note body\n')

    await fx.app.stop()
    await restoreBackup(dir, fx.dataDir, { force: true })
    assert.ok(fs.existsSync(path.join(fx.dataDir, 'whales.db')))
    const preRestore = fs.readdirSync(fx.dataDir).filter((name) => name.startsWith('.pre-restore-'))
    assert.equal(preRestore.length, 1)
    const aside = path.join(fx.dataDir, preRestore[0] ?? '')
    assert.ok(fs.existsSync(path.join(aside, 'whales.db')))
    assert.ok(fs.existsSync(path.join(aside, 'workspaces')))
  } finally {
    await teardown(fx)
  }
})

test('restoring a tampered backup writes nothing', async () => {
  const fx = await setup()
  try {
    const outRoot = path.join(fx.tmp, 'backups')
    const { dir } = await createBackup(fx.app, outRoot)
    await fx.app.stop()

    const tampered = path.join(fx.tmp, 'tampered')
    fs.cpSync(dir, tampered, { recursive: true })
    fs.appendFileSync(path.join(tampered, 'whales.db'), 'x')

    const target = path.join(fx.tmp, 'target')
    fs.mkdirSync(target, { recursive: true })
    await assert.rejects(() => restoreBackup(tampered, target), /checksum/)
    assert.deepEqual(fs.readdirSync(target), [])
  } finally {
    await teardown(fx)
  }
})
