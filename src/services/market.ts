import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Service, type Context, type Plugin } from 'cordis'
import type {
  BrowseResult,
  CatalogEntry,
  IndexEntry,
  InstallPreview,
  InstalledPlugin,
  InstalledView,
  MarketIndex,
  MarketService,
  MarketSource,
  PluginFile,
  PluginManifest,
} from '../contracts/market.ts'
import { newId } from '../core/ids.ts'
import { GIT_OPTIONS, cleanEnv, runGit } from '../core/git.ts'

/**
 * SECURITY-CRITICAL (orchestrator-owned). See contracts/market.ts for the trust model.
 *
 * Layout under `<dataDir>/plugins`:
 *   .staging/<previewId>/          staged plugin root (what the preview describes)
 *   .staging/<previewId>.git/      bare repo used for the pinned fetch (deleted after staging)
 *   <name>/<digest16>/             installed plugin root (imported from here)
 */

export interface MarketConfig {
  /** Absolute. Default `<dataDir>/plugins`. */
  dir?: string
  git?: string
  /** Tests only: allow plain-http index URLs. */
  allowHttpIndex?: boolean
  /** Tests only: map a `https://github.com/o/r` repo to another git URL (e.g. a local file:// repo). */
  repoUrl?: (repo: string) => string
}

export const PLUGIN_NAME = /^[a-z][a-z0-9-]{1,48}$/
const REPO = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/
const COMMIT = /^[0-9a-f]{40}$/
const SUBPATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
const ENTRY_EXT = new Set(['.js', '.mjs', '.ts'])
const MAX_FILES = 2000
const MAX_BYTES = 20 * 1024 * 1024
const MAX_INDEX_BYTES = 1024 * 1024
const MAX_INDEX_ENTRIES = 1000
const PREVIEW_TTL = 30 * 60 * 1000
const FETCH_TIMEOUT = 15_000
const GIT_TIMEOUT = 120_000
const MANIFEST = 'whales-plugin.json'

const FETCH_OPTIONS = [
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'http.followRedirects=false',
  '-c', 'core.symlinks=false',
  '-c', 'submodule.recurse=false',
  '-c', 'fetch.recurseSubmodules=false',
  '-c', 'transfer.fsckObjects=true',
]

interface Staged {
  preview: InstallPreview
  root: string
}

interface LoadState {
  state: InstalledView['state']
  error?: string
  unregister?: () => void
}

export class Market extends Service implements MarketService {
  static inject = ['store', 'agents']

  /** Resolves once every installed plugin has been loaded (or failed). createApp awaits it. */
  readonly ready: Promise<void>
  private own: Context
  private dir: string
  private gitBin: string
  private config: MarketConfig
  private staged = new Map<string, Staged>()
  private loads = new Map<string, LoadState>()
  private lock: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: MarketConfig = {}) {
    super(ctx, 'market')
    this.own = ctx
    this.config = config
    const dataDir = ctx.get('config')?.dataDir
    const dir = config.dir ?? (dataDir ? path.join(dataDir, 'plugins') : undefined)
    if (!dir || !path.isAbsolute(dir)) throw new TypeError('market: needs an absolute dir')
    this.dir = dir
    this.gitBin = config.git ?? 'git'
    ctx.effect(() => () => {
      for (const load of this.loads.values()) load.unregister?.()
      this.loads.clear()
    }, 'market-catalog')
    this.ready = this.loadAll()
  }

  // ---- sources -------------------------------------------------------------------------------------------------

  sources(): MarketSource[] {
    return this.own.store.collection('marketSources').list()
  }

  addSource(url: string): MarketSource {
    const parsed = this.indexUrl(url)
    const col = this.own.store.collection('marketSources')
    const existing = col.list().find((s) => s.url === parsed)
    if (existing) return existing
    return col.put({ id: newId('src'), scope: 'global', createdAt: Date.now(), url: parsed })
  }

  removeSource(id: string): boolean {
    return this.own.store.collection('marketSources').delete(id)
  }

  async browse(): Promise<BrowseResult[]> {
    return Promise.all(
      this.sources().map(async (source): Promise<BrowseResult> => {
        try {
          const index = await this.fetchIndex(source.url)
          return { source: source.url, name: index.name, entries: index.plugins }
        } catch (err) {
          return { source: source.url, entries: [], error: message(err) }
        }
      }),
    )
  }

  // ---- preview / install ---------------------------------------------------------------------------------------

  async preview(input: { source: string; name: string } | { repo: string; commit: string; path?: string } | { local: string }): Promise<InstallPreview> {
    this.sweep()
    if ('local' in input) return this.previewLocal(input.local)
    let entry: { repo: string; commit: string; path?: string }
    let index: string | undefined
    if ('source' in input) {
      index = this.indexUrl(input.source)
      const found = (await this.fetchIndex(index)).plugins.find((p) => p.name === input.name)
      if (!found) throw new Error(`plugin ${input.name} is not listed in ${index}`)
      entry = found
    } else {
      entry = checkPin(input)
    }
    return this.previewGithub(entry, index)
  }

  install(previewId: string, digest: string): Promise<InstalledView> {
    return this.exclusive(async () => {
      this.sweep()
      const staged = this.staged.get(previewId)
      if (!staged) throw new Error('preview not found or expired; preview the plugin again')
      if (staged.preview.digest !== digest) throw new Error('digest does not match the preview')
      // Re-hash what is on disk: the installed bytes are exactly the previewed bytes.
      const { digest: now } = await describeTree(staged.root)
      if (now !== digest) throw new Error('staged files changed since the preview; preview the plugin again')
      const { manifest } = staged.preview
      const col = this.own.store.collection('plugins')
      const previous = col.get(manifest.name)
      if (!previous && this.own.agents.catalog.resolve(manifest.name)) {
        throw new Error(`"${manifest.name}" is already a built-in plugin name`)
      }

      const target = path.join(this.dir, manifest.name, digest.slice(0, 16))
      this.inside(target)
      if (existsSync(target)) await rm(target, { recursive: true, force: true })
      await mkdir(path.dirname(target), { recursive: true })
      await rename(staged.root, target)
      this.staged.delete(previewId)

      const record: InstalledPlugin = {
        id: manifest.name,
        scope: 'global',
        createdAt: Date.now(),
        name: manifest.name,
        manifest,
        origin: staged.preview.origin,
        digest,
        dir: target,
      }
      // Load before committing the record, so a broken plugin never replaces a working one.
      let plugin: Plugin
      try {
        plugin = await importPlugin(record)
      } catch (err) {
        if (previous?.dir !== target) await this.removeDir(target)
        throw err
      }
      this.loads.get(manifest.name)?.unregister?.()
      col.put(record)
      this.register(record, plugin)
      if (previous && previous.dir !== target) await this.removeDir(previous.dir)
      this.own.emit('whales/catalog-changed', manifest.name)
      return this.view(record)
    })
  }

  uninstall(name: string): Promise<boolean> {
    return this.exclusive(async () => {
      const col = this.own.store.collection('plugins')
      const record = col.get(name)
      if (!record) return false
      const usedBy = this.usedBy(name)
      if (usedBy.agents.length || usedBy.rooms.length) {
        const parts = [...usedBy.agents.map((a) => `agent ${a}`), ...usedBy.rooms.map((r) => `room ${r}`)]
        throw new Error(`plugin ${name} is still used by ${parts.join(', ')}; remove it there first`)
      }
      this.loads.get(name)?.unregister?.()
      this.loads.delete(name)
      col.delete(name)
      await this.removeDir(path.join(this.dir, name))
      this.own.emit('whales/catalog-changed', name)
      return true
    })
  }

  list(): InstalledView[] {
    return this.own.store.collection('plugins').list().map((record) => this.view(record))
  }

  catalog(): CatalogEntry[] {
    const installed = new Map(this.list().map((p) => [p.name, p]))
    return this.own.agents.catalog.names().map((name): CatalogEntry => {
      const plugin = installed.get(name)
      if (!plugin) return { name, kind: 'builtin', scopes: BUILTIN_ROOM_OK.has(name) ? ['agent', 'room'] : ['agent'] }
      const entry: CatalogEntry = { name, kind: 'market', description: plugin.manifest.description, version: plugin.manifest.version, scopes: plugin.manifest.scopes ?? ['agent', 'room'] }
      return entry
    })
  }

  // ---- internals -----------------------------------------------------------------------------------------------

  private async loadAll(): Promise<void> {
    for (const record of this.own.store.collection('plugins').list()) {
      try {
        if (this.own.agents.catalog.resolve(record.name)) throw new Error(`name clashes with a built-in plugin`)
        this.inside(record.dir)
        const { digest } = await describeTree(record.dir)
        if (digest !== record.digest) throw new Error('installed files were modified after install; reinstall the plugin')
        this.register(record, await importPlugin(record))
      } catch (err) {
        this.loads.set(record.name, { state: 'failed', error: message(err) })
        this.own.logger('market').warn('plugin %s failed to load: %s', record.name, message(err))
      }
    }
  }

  private register(record: InstalledPlugin, plugin: Plugin): void {
    const unregister = this.own.agents.catalog.register(record.name, plugin)
    this.loads.set(record.name, { state: 'loaded', unregister })
  }

  private view(record: InstalledPlugin): InstalledView {
    const load = this.loads.get(record.name)
    const view: InstalledView = { ...record, state: load?.state ?? 'pending-restart', usedBy: this.usedBy(record.name) }
    if (load?.error) view.error = load.error
    return view
  }

  private usedBy(name: string): { agents: string[]; rooms: string[] } {
    const agents = this.own.store
      .collection('agents')
      .list()
      .filter((r) => r.spec.plugins.some((p) => p.name === name) || r.spec.driver.name === name)
      .map((r) => r.id)
    const rooms = this.own.get('rooms')?.list().filter((r) => r.plugins?.some((p) => p.name === name)).map((r) => r.id) ?? []
    return { agents, rooms }
  }

  private indexUrl(url: string): string {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new TypeError('index URL is not a valid URL')
    }
    const httpOk = this.config.allowHttpIndex === true && parsed.protocol === 'http:'
    if (parsed.protocol !== 'https:' && !httpOk) throw new TypeError('index URL must use https')
    if (parsed.username || parsed.password) throw new TypeError('index URL must not contain credentials')
    return parsed.href
  }

  private async fetchIndex(url: string): Promise<MarketIndex> {
    const res = await fetch(this.indexUrl(url), { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`index ${url}: HTTP ${res.status}`)
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > MAX_INDEX_BYTES) throw new Error(`index ${url}: larger than 1 MiB`)
    const text = await readCapped(res, MAX_INDEX_BYTES)
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`index ${url}: not valid JSON`)
    }
    return parseIndex(data)
  }

  private async previewGithub(entry: { repo: string; commit: string; path?: string }, index: string | undefined): Promise<InstallPreview> {
    const id = newId('pv')
    const staging = path.join(this.dir, '.staging')
    const gitDir = path.join(staging, `${id}.git`)
    const tree = path.join(staging, `${id}.tree`)
    const root = path.join(staging, id)
    await mkdir(tree, { recursive: true })
    const url = this.config.repoUrl ? this.config.repoUrl(entry.repo) : `${entry.repo}.git`
    const extra = this.config.repoUrl ? ['-c', 'protocol.file.allow=always', '-c', 'uploadpack.allowAnySHA1InWant=true'] : []
    const git = (args: string[]) => runGit(this.gitBin, [...GIT_OPTIONS, ...FETCH_OPTIONS, ...extra, ...args], cleanEnv({ GIT_LFS_SKIP_SMUDGE: '1' }), staging, GIT_TIMEOUT)
    try {
      await git(['init', '-q', '--bare', gitDir])
      await git(['--git-dir', gitDir, 'fetch', '-q', '--depth', '1', '--no-tags', '--', url, entry.commit])
      const resolved = (await git(['--git-dir', gitDir, 'rev-parse', '--verify', `${entry.commit}^{commit}`])).trim()
      if (resolved !== entry.commit) throw new Error('fetched commit does not match the pinned commit')
      await git(['--git-dir', gitDir, '--work-tree', tree, 'checkout', '-q', entry.commit, '--', entry.path ?? '.'])
      const source = entry.path ? path.join(tree, entry.path) : tree
      if (!existsSync(source)) throw new Error(`path ${entry.path} does not exist at that commit`)
      await rename(source, root)
      const origin: InstallPreview['origin'] = { kind: 'github', repo: entry.repo, commit: entry.commit, ...(entry.path ? { path: entry.path } : {}), ...(index ? { index } : {}) }
      return await this.describe(id, root, origin)
    } catch (err) {
      await rm(root, { recursive: true, force: true })
      throw err
    } finally {
      await rm(gitDir, { recursive: true, force: true })
      await rm(tree, { recursive: true, force: true })
    }
  }

  private async previewLocal(dir: string): Promise<InstallPreview> {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new TypeError('local plugin path must be absolute')
    const info = await lstat(dir).catch(() => undefined)
    if (!info?.isDirectory()) throw new Error(`${dir} is not a folder`)
    const id = newId('pv')
    const root = path.join(this.dir, '.staging', id)
    await mkdir(path.dirname(root), { recursive: true })
    try {
      // Symlinks are refused (not followed); .git and node_modules are left behind.
      await cp(dir, root, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (src) => {
          const base = path.basename(src)
          return base !== '.git' && base !== 'node_modules'
        },
      })
      return await this.describe(id, root, { kind: 'local', path: dir })
    } catch (err) {
      await rm(root, { recursive: true, force: true })
      throw err
    }
  }

  private async describe(id: string, root: string, origin: InstallPreview['origin']): Promise<InstallPreview> {
    const { files, totalBytes, digest } = await describeTree(root)
    const manifest = parseManifest(await readFile(path.join(root, MANIFEST), 'utf8').catch(() => {
      throw new Error(`no ${MANIFEST} at the plugin root`)
    }))
    const entryPath = path.resolve(root, manifest.entry)
    if (!entryPath.startsWith(root + path.sep)) throw new Error('manifest entry escapes the plugin folder')
    if (!files.some((f) => path.join(root, f.path) === entryPath)) throw new Error(`entry ${manifest.entry} does not exist`)
    const builtin = this.own.agents.catalog.resolve(manifest.name) && !this.own.store.collection('plugins').get(manifest.name)
    if (builtin) throw new Error(`"${manifest.name}" is already a built-in plugin name`)

    const warnings: string[] = []
    if (files.some((f) => f.path === 'package.json')) {
      try {
        const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>
        const deps = Object.keys({ ...(pkg.dependencies as object), ...(pkg.peerDependencies as object) })
        if (deps.length) warnings.push(`package.json lists dependencies (${deps.join(', ')}); Whales does not install them, so imports of them will fail`)
        if (pkg.scripts && typeof pkg.scripts === 'object' && Object.keys(pkg.scripts).some((s) => /install|prepare/.test(s))) {
          warnings.push('package.json has install scripts; Whales never runs them')
        }
      } catch {
        warnings.push('package.json is not valid JSON')
      }
    }
    if (origin.kind === 'local') warnings.push('installed from a local folder: no commit pin, the digest is the only identity')
    const existing = this.own.store.collection('plugins').get(manifest.name)
    if (existing) warnings.push(existing.digest === digest ? 'this exact version is already installed' : `replaces installed version ${existing.manifest.version}`)

    const preview: InstallPreview = { id, manifest, origin, files, totalBytes, digest, warnings, expiresAt: Date.now() + PREVIEW_TTL }
    this.staged.set(id, { preview, root })
    return preview
  }

  private sweep(): void {
    const now = Date.now()
    for (const [id, staged] of this.staged) {
      if (staged.preview.expiresAt <= now) {
        this.staged.delete(id)
        void rm(staged.root, { recursive: true, force: true })
      }
    }
  }

  /** Every path we delete or install into must sit strictly inside the plugins dir. */
  private inside(target: string): void {
    const rel = path.relative(this.dir, target)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`refusing to touch ${target}: outside the plugins folder`)
  }

  private async removeDir(target: string): Promise<void> {
    this.inside(target)
    await rm(target, { recursive: true, force: true })
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn)
    this.lock = next.catch(() => {})
    return next
  }
}

/** Built-ins that make sense room-scoped (none today: they all provide per-agent services). */
const BUILTIN_ROOM_OK = new Set<string>()

// ---- pure helpers (exported for tests) -------------------------------------------------------------------------

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function str(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new TypeError(`${field} must be a string of 1 to ${max} characters`)
  return value
}

function optStr(value: unknown, field: string, max: number): string | undefined {
  return value === undefined ? undefined : str(value, field, max)
}

function scopes(value: unknown, field: string): ('agent' | 'room')[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => v === 'agent' || v === 'room')) {
    throw new TypeError(`${field} must be a non-empty array of "agent" | "room"`)
  }
  return [...new Set(value as ('agent' | 'room')[])]
}

function checkPin(input: { repo: string; commit: string; path?: string }): { repo: string; commit: string; path?: string } {
  const repo = typeof input.repo === 'string' ? input.repo.replace(/\.git$/, '').replace(/\/$/, '') : ''
  if (!REPO.test(repo)) throw new TypeError('repo must be https://github.com/<owner>/<repo>')
  if (typeof input.commit !== 'string' || !COMMIT.test(input.commit)) throw new TypeError('commit must be a full 40-character commit hash')
  const out: { repo: string; commit: string; path?: string } = { repo, commit: input.commit }
  if (input.path !== undefined) {
    if (typeof input.path !== 'string' || !SUBPATH.test(input.path) || input.path.split('/').some((s) => s === '.' || s === '..')) {
      throw new TypeError('path must be a plain relative folder path')
    }
    out.path = input.path
  }
  return out
}

export function parseIndex(data: unknown): MarketIndex {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new TypeError('index must be a JSON object')
  const obj = data as Record<string, unknown>
  if (obj.version !== 1) throw new TypeError('index version must be 1')
  const name = str(obj.name, 'index name', 100)
  if (!Array.isArray(obj.plugins)) throw new TypeError('index plugins must be an array')
  if (obj.plugins.length > MAX_INDEX_ENTRIES) throw new TypeError(`index lists more than ${MAX_INDEX_ENTRIES} plugins`)
  const seen = new Set<string>()
  const plugins = obj.plugins.map((raw, i): IndexEntry => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError(`plugins[${i}] must be an object`)
    const e = raw as Record<string, unknown>
    const entryName = str(e.name, `plugins[${i}].name`, 49)
    if (!PLUGIN_NAME.test(entryName)) throw new TypeError(`plugins[${i}].name is not a valid plugin name`)
    if (seen.has(entryName)) throw new TypeError(`plugin ${entryName} is listed twice`)
    seen.add(entryName)
    const pin = checkPin({ repo: e.repo as string, commit: e.commit as string, ...(e.path === undefined ? {} : { path: e.path as string }) })
    const entry: IndexEntry = { name: entryName, version: str(e.version, `${entryName}.version`, 64), description: str(e.description, `${entryName}.description`, 500), ...pin }
    const author = optStr(e.author, `${entryName}.author`, 100)
    const license = optStr(e.license, `${entryName}.license`, 64)
    const homepage = optStr(e.homepage, `${entryName}.homepage`, 300)
    if (homepage !== undefined && !/^https:\/\//.test(homepage)) throw new TypeError(`${entryName}.homepage must be https`)
    const sc = scopes(e.scopes, `${entryName}.scopes`)
    if (author !== undefined) entry.author = author
    if (license !== undefined) entry.license = license
    if (homepage !== undefined) entry.homepage = homepage
    if (sc) entry.scopes = sc
    if (e.tags !== undefined) {
      if (!Array.isArray(e.tags) || e.tags.length > 10 || !e.tags.every((t) => typeof t === 'string' && t.length > 0 && t.length <= 32)) {
        throw new TypeError(`${entryName}.tags must be up to 10 short strings`)
      }
      entry.tags = e.tags as string[]
    }
    return entry
  })
  return { version: 1, name, plugins }
}

export function parseManifest(text: string): PluginManifest {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new TypeError(`${MANIFEST} is not valid JSON`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new TypeError(`${MANIFEST} must be an object`)
  const m = data as Record<string, unknown>
  const name = str(m.name, 'manifest name', 49)
  if (!PLUGIN_NAME.test(name)) throw new TypeError('manifest name must match ^[a-z][a-z0-9-]{1,48}$')
  const entry = str(m.entry, 'manifest entry', 200)
  if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) throw new TypeError('manifest entry must be a relative path inside the plugin')
  if (!ENTRY_EXT.has(path.extname(entry))) throw new TypeError('manifest entry must be a .js, .mjs or .ts file')
  const manifest: PluginManifest = { name, version: str(m.version, 'manifest version', 64), description: str(m.description, 'manifest description', 500), entry }
  const author = optStr(m.author, 'manifest author', 100)
  const license = optStr(m.license, 'manifest license', 64)
  const homepage = optStr(m.homepage, 'manifest homepage', 300)
  const sc = scopes(m.scopes, 'manifest scopes')
  if (author !== undefined) manifest.author = author
  if (license !== undefined) manifest.license = license
  if (homepage !== undefined) manifest.homepage = homepage
  if (sc) manifest.scopes = sc
  return manifest
}

/** Lists regular files (refusing symlinks and special files), enforces limits, and hashes path + content. */
export async function describeTree(root: string): Promise<{ files: PluginFile[]; totalBytes: number; digest: string }> {
  const files: PluginFile[] = []
  let totalBytes = 0
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full).split(path.sep).join('/')
      if (entry.isSymbolicLink()) throw new Error(`plugin contains a symlink (${rel}); symlinks are not allowed`)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        const { size } = await lstat(full)
        totalBytes += size
        files.push({ path: rel, bytes: size })
        if (files.length > MAX_FILES) throw new Error(`plugin has more than ${MAX_FILES} files`)
        if (totalBytes > MAX_BYTES) throw new Error('plugin is larger than 20 MiB')
      } else {
        throw new Error(`plugin contains a special file (${rel})`)
      }
    }
  }
  await walk(root)
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const hash = createHash('sha256')
  for (const file of files) {
    const content = await readFile(path.join(root, file.path))
    hash.update(`${file.path}\0${content.length}\0`)
    hash.update(content)
  }
  return { files, totalBytes, digest: hash.digest('hex') }
}

/** Import the entry module and check it looks like a Cordis plugin. The digest in the URL defeats the ESM cache. */
async function importPlugin(record: InstalledPlugin): Promise<Plugin> {
  const entry = path.resolve(record.dir, record.manifest.entry)
  if (!entry.startsWith(record.dir + path.sep)) throw new Error('manifest entry escapes the plugin folder')
  const mod = (await import(`${pathToFileURL(entry).href}?v=${record.digest.slice(0, 16)}`)) as { default?: unknown }
  const plugin = mod.default
  const ok = typeof plugin === 'function' || (typeof plugin === 'object' && plugin !== null && typeof (plugin as { apply?: unknown }).apply === 'function')
  if (!ok) throw new Error('the entry module must `export default` a Cordis plugin (a function or { apply })')
  return plugin as Plugin
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      throw new Error('index is larger than 1 MiB')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
