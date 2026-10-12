import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Service, type Context } from 'cordis'
import { isSkillName, newId } from '../core/ids.ts'
import type { Skill, SkillMeta, SkillPreview, SkillsService } from '../contracts/skills.ts'
import type {} from '../contracts/config.ts'
import type {} from '../contracts/store.ts'

const DEFAULT_MAX_BYTES = 262144
const DESCRIPTION_MAX = 300
const FETCH_TIMEOUT_MS = 15000

export class SkillParseError extends Error {
  override name = 'SkillParseError'
}

export interface ParsedSkill {
  name: string
  description: string
  body: string
}

/** Pure. Throws SkillParseError. */
export function parseSkill(text: string): ParsedSkill {
  const normalised = text.replace(/\r\n/g, '\n')
  if (!normalised.startsWith('---\n')) {
    throw new SkillParseError('skill: text must start with a "---" front-matter line')
  }
  const lines = normalised.split('\n')
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i
      break
    }
  }
  if (end === -1) {
    throw new SkillParseError('skill: front matter is missing its closing "---" line')
  }
  const frontMatter = lines.slice(1, end)
  const body = lines.slice(end + 1).join('\n').trim()

  let name: string | undefined
  let description: string | undefined
  for (const raw of frontMatter) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon === -1) {
      throw new SkillParseError(`skill: front-matter line is not "key: value": ${JSON.stringify(raw)}`)
    }
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key === 'name') name = value
    else if (key === 'description') description = value
  }

  if (name === undefined) {
    throw new SkillParseError('skill: front matter is missing the required "name" key')
  }
  if (!isSkillName(name)) {
    throw new SkillParseError(`skill: invalid name ${JSON.stringify(name)} (expected /^[a-z0-9][a-z0-9-]{0,63}$/)`)
  }
  if (description === undefined) {
    throw new SkillParseError('skill: front matter is missing the required "description" key')
  }
  if (description.length < 1 || description.length > DESCRIPTION_MAX) {
    throw new SkillParseError(
      `skill: description must be 1..${DESCRIPTION_MAX} characters, got ${description.length}`,
    )
  }
  return { name, description, body }
}

export interface SkillsConfig {
  /** Absolute. Default `path.join(ctx.config.dataDir, 'skills')`. */
  dir?: string
  /** Default 262144. */
  maxBytes?: number
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

export class SkillLibrary extends Service implements SkillsService {
  static inject = ['store']

  readonly dir: string
  private readonly maxBytes: number
  private readonly store: Context['store']
  private readonly ownCtx: Context

  constructor(ctx: Context, config?: SkillsConfig) {
    super(ctx, 'skills')
    const dataDir = ctx.get('config')?.dataDir
    const dir = config?.dir ?? (dataDir === undefined ? undefined : path.join(dataDir, 'skills'))
    if (dir === undefined) throw new TypeError('skills: no dir configured and no app config to derive it from')
    if (!path.isAbsolute(dir)) {
      throw new TypeError(`skills: dir must be absolute, got ${JSON.stringify(dir)}`)
    }
    this.dir = dir
    this.maxBytes = config?.maxBytes ?? DEFAULT_MAX_BYTES
    this.store = ctx.store
    this.ownCtx = ctx
  }

  async list(): Promise<SkillMeta[]> {
    let entries: string[]
    try {
      const dirents = await readdir(this.dir, { withFileTypes: true })
      entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      return []
    }
    const metas: SkillMeta[] = []
    for (const entry of entries) {
      if (!isSkillName(entry)) {
        this.ownCtx.logger('skills').warn('skipping skill directory with invalid name %s', entry)
        continue
      }
      const file = path.join(this.dir, entry, 'SKILL.md')
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch {
        this.ownCtx.logger('skills').warn('skipping skill %s: SKILL.md is missing or unreadable', entry)
        continue
      }
      let parsed: ParsedSkill
      try {
        parsed = parseSkill(text)
      } catch (err) {
        this.ownCtx.logger('skills').warn('skipping skill %s: %s', entry, err instanceof Error ? err.message : String(err))
        continue
      }
      if (parsed.name !== entry) {
        this.ownCtx.logger('skills').warn(
          'skipping skill %s: front-matter name %s does not match the directory name',
          entry,
          parsed.name,
        )
        continue
      }
      metas.push({ name: parsed.name, description: parsed.description })
    }
    metas.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return metas
  }

  async read(name: string): Promise<Skill | undefined> {
    if (!isSkillName(name)) return undefined
    const file = path.join(this.dir, name, 'SKILL.md')
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return undefined
    }
    let parsed: ParsedSkill
    try {
      parsed = parseSkill(text)
    } catch {
      return undefined
    }
    if (parsed.name !== name) return undefined
    return { name: parsed.name, description: parsed.description, body: parsed.body, path: file }
  }

  async preview(source: string): Promise<SkillPreview> {
    return (await this.fetchPreview(source)).preview
  }

  /** Loads once and returns the preview together with the exact bytes it describes. */
  private async fetchPreview(source: string): Promise<{ preview: SkillPreview; bytes: Buffer }> {
    const { bytes, origin } = await this.load(source)
    if (bytes.byteLength > this.maxBytes) {
      throw new Error(`skills: content is ${bytes.byteLength} bytes, which exceeds the limit of ${this.maxBytes} bytes`)
    }
    const hash = createHash('sha256').update(bytes).digest('hex')
    const parsed = parseSkill(bytes.toString('utf8'))
    const existing = await this.read(parsed.name)
    const preview: SkillPreview = { name: parsed.name, description: parsed.description, body: parsed.body, source: origin, hash }
    if (existing) preview.existing = { name: existing.name, description: existing.description }
    return { preview, bytes }
  }

  async install(source: string, hash: string): Promise<Skill> {
    // SECURITY: load once; the bytes that were hashed are the bytes that get written.
    const { preview, bytes } = await this.fetchPreview(source)
    if (preview.hash !== hash) {
      throw new Error(
        `skills: source changed since preview (expected hash ${hash}, got ${preview.hash}); nothing was written`,
      )
    }
    const targetDir = path.join(this.dir, preview.name)
    const target = path.join(targetDir, 'SKILL.md')
    const resolvedDir = path.resolve(this.dir)
    const resolvedTarget = path.resolve(target)
    if (!resolvedTarget.startsWith(resolvedDir + path.sep)) {
      throw new Error(`skills: refusing to write outside ${resolvedDir}: ${resolvedTarget}`)
    }
    await mkdir(targetDir, { recursive: true })
    const tmp = path.join(targetDir, `.SKILL.md.${randomBytes(8).toString('hex')}.tmp`)
    await writeFile(tmp, bytes)
    await rename(tmp, target)
    await this.store.collection('skillInstalls').put({
      id: newId('skill'),
      scope: 'global',
      createdAt: Date.now(),
      name: preview.name,
      source: preview.source,
      hash: preview.hash,
    })
    const installed = await this.read(preview.name)
    if (!installed) {
      throw new Error(`skills: installed skill ${preview.name} could not be read back`)
    }
    return installed
  }

  async remove(name: string): Promise<boolean> {
    if (!isSkillName(name)) return false
    const targetDir = path.join(this.dir, name)
    try {
      const info = await stat(targetDir)
      if (!info.isDirectory()) return false
    } catch {
      return false
    }
    await rm(targetDir, { recursive: true, force: true })
    return true
  }

  /** Read the exact bytes of a source (https URL, loopback http URL, or absolute local path). */
  private async load(source: string): Promise<{ bytes: Buffer; origin: string }> {
    if (source.startsWith('https://') || source.startsWith('http://')) {
      return this.loadRemote(source)
    }
    if (!path.isAbsolute(source)) {
      throw new Error(`skills: source must be an absolute path or an https URL, got ${JSON.stringify(source)}`)
    }
    let file = source
    const info = await stat(source)
    if (info.isDirectory()) file = path.join(source, 'SKILL.md')
    const size = (await stat(file)).size
    if (size > this.maxBytes) {
      throw new Error(`skills: content is ${size} bytes, which exceeds the limit of ${this.maxBytes} bytes`)
    }
    const bytes = await readFile(file)
    return { bytes, origin: source }
  }

  private async loadRemote(source: string): Promise<{ bytes: Buffer; origin: string }> {
    const url = new URL(source)
    if (url.protocol === 'http:') {
      if (!isLoopbackHost(url.hostname)) {
        throw new Error(`skills: refusing plain http for ${source}; use https (loopback http is allowed)`)
      }
    } else if (url.protocol !== 'https:') {
      throw new Error(`skills: unsupported URL scheme ${url.protocol} for ${source}; use https`)
    }
    const res = await fetch(source, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${source}`)
    }
    const declared = res.headers.get('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > this.maxBytes) {
        throw new Error(
          `skills: content-length ${length} exceeds the limit of ${this.maxBytes} bytes for ${source}`,
        )
      }
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    return { bytes, origin: source }
  }
}

/** Per-agent plugin, catalog name 'skills'. Config { names: string[] }. */
export const AgentSkills: { inject: string[]; apply(ctx: Context, config: { names: string[] }): void } = {
  inject: ['agent', 'skills'],
  apply(ctx: Context, config: { names: string[] }): void {
    const names = config?.names ?? []
    if (!Array.isArray(names)) {
      throw new TypeError('skills: config.names must be an array of skill names')
    }
    for (const name of names) {
      if (!isSkillName(name)) {
        throw new TypeError(`skills: invalid skill name ${JSON.stringify(name)} in config.names`)
      }
    }
    const skills = ctx.skills
    const warned = new Set<string>()
    ctx.agent.addPromptSection({
      id: 'skills',
      order: 100,
      async render(): Promise<string> {
        const sections: string[] = []
        for (const name of names) {
          const skill = await skills.read(name)
          if (!skill) {
            if (!warned.has(name)) {
              warned.add(name)
              ctx.logger('skills').warn('skill %s is not installed; skipping', name)
            }
            continue
          }
          const head = `## Skill: ${skill.name}\n${skill.description}`
          sections.push(skill.body === '' ? head : `${head}\n\n${skill.body}`)
        }
        return sections.join('\n\n')
      },
    })
  },
}
