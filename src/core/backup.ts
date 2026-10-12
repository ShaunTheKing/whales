import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { App } from './app.ts'

export interface BackupManifest {
  format: 'whales-backup'
  version: 1
  createdAt: string
  dataDir: string
  database: { file: 'whales.db'; sha256: string; bytes: number }
  directories: string[]
  files: number
}

const BACKUP_DIRS = ['skills', 'workspaces', 'checkpoints'] as const
const DB_FILE = 'whales.db'
const CONFIG_FILE = 'whales.config.json'

function timestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

async function sha256(file: string): Promise<string> {
  const data = await fs.readFile(file)
  return createHash('sha256').update(data).digest('hex')
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

/** Counts regular files recursively; symlinks and other non-regular entries do not count. */
async function countFiles(dir: string): Promise<number> {
  let total = 0
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    const st = await fs.lstat(full)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) total += await countFiles(full)
    else if (st.isFile()) total += 1
  }
  return total
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.cp(src, dest, {
    recursive: true,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
  })
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export async function createBackup(app: App, outRoot: string): Promise<{ dir: string; manifest: BackupManifest }> {
  if (!path.isAbsolute(outRoot)) throw new TypeError('backup outRoot must be an absolute path')
  const dataDir = path.resolve(app.ctx.config.dataDir)
  const root = path.resolve(outRoot)
  if (isInside(root, dataDir)) throw new Error('backup directory must be outside the data dir')

  await fs.mkdir(root, { recursive: true })

  const base = `whales-backup-${timestamp(new Date())}`
  let dir = path.join(root, base)
  let suffix = 2
  while (await exists(dir)) {
    dir = path.join(root, `${base}-${suffix}`)
    suffix += 1
  }
  await fs.mkdir(dir)

  const dbDest = path.join(dir, DB_FILE)
  app.ctx.store.backupTo(dbDest)
  const dbStat = await fs.stat(dbDest)
  const database = { file: 'whales.db' as const, sha256: await sha256(dbDest), bytes: dbStat.size }

  const directories: string[] = []
  let files = 0
  for (const name of BACKUP_DIRS) {
    const src = path.join(dataDir, name)
    if (!(await exists(src))) continue
    await copyDir(src, path.join(dir, name))
    directories.push(name)
    files += await countFiles(src)
  }

  const configSrc = path.join(dataDir, CONFIG_FILE)
  if (await exists(configSrc)) {
    await fs.copyFile(configSrc, path.join(dir, CONFIG_FILE))
    files += 1
  }

  const manifest: BackupManifest = {
    format: 'whales-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    dataDir,
    database,
    directories,
    files,
  }
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { dir, manifest }
}

export async function readBackup(dir: string): Promise<BackupManifest> {
  if (!path.isAbsolute(dir)) throw new TypeError('backup dir must be an absolute path')
  const manifestPath = path.join(dir, 'manifest.json')
  let raw: string
  try {
    raw = await fs.readFile(manifestPath, 'utf8')
  } catch {
    throw new Error(`backup manifest not found: ${manifestPath}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`backup manifest is not valid JSON: ${manifestPath}`)
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('backup manifest is not an object')
  const manifest = parsed as BackupManifest
  if (manifest.format !== 'whales-backup') throw new Error(`unsupported backup format: ${String(manifest.format)}`)
  if (manifest.version !== 1) throw new Error(`unsupported backup version: ${String(manifest.version)}`)
  if (typeof manifest.database !== 'object' || manifest.database === null) {
    throw new Error('backup manifest is missing database info')
  }
  if (manifest.database.file !== DB_FILE) throw new Error(`backup database file must be ${DB_FILE}`)
  if (!Array.isArray(manifest.directories)) throw new Error('backup manifest directories must be an array')
  for (const name of manifest.directories) {
    if (!(BACKUP_DIRS as readonly string[]).includes(name)) {
      throw new Error(`backup manifest lists unknown directory: ${String(name)}`)
    }
    if (!(await exists(path.join(dir, name)))) {
      throw new Error(`backup is missing listed directory: ${String(name)}`)
    }
  }
  const dbPath = path.join(dir, DB_FILE)
  if (!(await exists(dbPath))) throw new Error(`backup is missing ${DB_FILE}`)
  const actual = await sha256(dbPath)
  if (actual !== manifest.database.sha256) {
    throw new Error(`backup checksum mismatch for ${DB_FILE}`)
  }
  return manifest
}

export async function restoreBackup(
  dir: string,
  dataDir: string,
  opts?: { force?: boolean },
): Promise<BackupManifest> {
  const manifest = await readBackup(dir)
  if (!path.isAbsolute(dataDir)) throw new TypeError('dataDir must be an absolute path')
  const target = path.resolve(dataDir)
  await fs.mkdir(target, { recursive: true })

  const force = opts?.force === true
  const currentDb = path.join(target, DB_FILE)
  if ((await exists(currentDb)) && !force) {
    throw new Error(`data dir already contains ${DB_FILE}; pass --force to overwrite`)
  }

  if (force) {
    const aside = path.join(target, `.pre-restore-${timestamp(new Date())}`)
    await fs.mkdir(aside)
    const movable = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, CONFIG_FILE, ...BACKUP_DIRS]
    for (const name of movable) {
      const src = path.join(target, name)
      if (await exists(src)) await fs.rename(src, path.join(aside, name))
    }
  }

  await fs.copyFile(path.join(dir, DB_FILE), path.join(target, DB_FILE))
  const configSrc = path.join(dir, CONFIG_FILE)
  if (await exists(configSrc)) await fs.copyFile(configSrc, path.join(target, CONFIG_FILE))
  for (const name of manifest.directories) {
    await copyDir(path.join(dir, name), path.join(target, name))
  }
  return manifest
}
