import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { Context } from 'cordis'
import type { Tool, ToolResult } from '../contracts/tools.ts'

/**
 * SECURITY-CRITICAL (orchestrator-owned). Per-agent file tools confined to the agent's workdir.
 * Catalog name 'workspace'. Every call is described as a file.read / file.write Action, so the tools gate
 * (rules → approvals) decides before anything touches the disk. Confinement is enforced twice:
 *  1. lexically in describe(): relative paths only, no '..' escape (invalid input → the call never runs);
 *  2. physically in run(): the real path (symlinks resolved) must stay inside the real workdir; writes never
 *     follow a symlink at the target.
 */

const MAX_READ_BYTES = 256 * 1024
const MAX_WRITE_BYTES = 1024 * 1024
const MAX_LIST = 500

export interface WorkspaceConfig {
  /** Absolute. Default: spec.workdir, else `<dataDir>/workspaces/<agentId>`. */
  dir?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Lexical confinement. Returns the workdir-relative POSIX path ('' for the root). Throws on escape. */
export function confine(workdir: string, input: unknown, field = 'path'): { rel: string; abs: string } {
  if (typeof input !== 'string' || input.length > 1024 || input.includes('\0')) {
    throw new TypeError(`${field} must be a string of at most 1024 characters`)
  }
  const raw = input.replace(/\\/g, '/')
  if (path.posix.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) throw new TypeError(`${field} must be relative to the workspace`)
  const rel = path.posix.normalize(raw === '' ? '.' : raw).replace(/\/$/, '')
  if (rel === '..' || rel.startsWith('../')) throw new TypeError(`${field} must stay inside the workspace`)
  const clean = rel === '.' ? '' : rel
  return { rel: clean, abs: path.join(workdir, clean) }
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

/** Physical confinement: resolves symlinks of the deepest existing ancestor. */
async function assertInside(workdir: string, abs: string): Promise<void> {
  const root = await realpath(workdir)
  let probe = abs
  for (;;) {
    try {
      const real = await realpath(probe)
      if (!within(root, real)) throw new Error('path resolves outside the workspace')
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const parent = path.dirname(probe)
      if (parent === probe) throw new Error('path resolves outside the workspace')
      probe = parent
    }
  }
}

function result(output: string, isError = false): ToolResult {
  return { output, isError }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function makeWorkspaceTools(workdir: string): Tool[] {
  const listFiles: Tool = {
    spec: {
      name: 'list_files',
      description: 'List files and folders in your workspace. Folders end with "/".',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Folder relative to the workspace; default "."' } }, additionalProperties: false },
    },
    describe(input) {
      const raw = isRecord(input) && input.path !== undefined ? input.path : '.'
      const { rel } = confine(workdir, raw)
      return { kind: 'file.read', target: rel === '' ? '.' : rel, summary: `list ${rel || '.'}` }
    },
    async run(input) {
      const raw = isRecord(input) && input.path !== undefined ? input.path : '.'
      try {
        const { abs } = confine(workdir, raw)
        await assertInside(workdir, abs)
        const entries = await readdir(abs, { withFileTypes: true })
        const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort((a, b) => a.localeCompare(b))
        const shown = names.slice(0, MAX_LIST)
        const more = names.length > MAX_LIST ? `\n… ${names.length - MAX_LIST} more` : ''
        return result(shown.length ? shown.join('\n') + more : '(empty)')
      } catch (err) {
        return result(`list_files failed: ${errorText(err)}`, true)
      }
    },
  }

  const readFileTool: Tool = {
    spec: {
      name: 'read_file',
      description: 'Read a UTF-8 text file from your workspace (max 256 KiB).',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    },
    describe(input) {
      if (!isRecord(input)) throw new TypeError('input must be an object')
      const { rel } = confine(workdir, input.path)
      if (rel === '') throw new TypeError('path must name a file')
      return { kind: 'file.read', target: rel, summary: `read ${rel}` }
    },
    async run(input) {
      try {
        if (!isRecord(input)) throw new TypeError('input must be an object')
        const { abs } = confine(workdir, input.path)
        await assertInside(workdir, abs)
        const info = await lstat(abs)
        if (!info.isFile()) throw new Error('not a regular file')
        if (info.size > MAX_READ_BYTES) throw new Error(`file is ${info.size} bytes; the limit is ${MAX_READ_BYTES}`)
        return result(await readFile(abs, 'utf8'))
      } catch (err) {
        return result(`read_file failed: ${errorText(err)}`, true)
      }
    },
  }

  const writeFileTool: Tool = {
    spec: {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 text file in your workspace (max 1 MiB). Folders are created as needed.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    describe(input) {
      if (!isRecord(input)) throw new TypeError('input must be an object')
      const { rel } = confine(workdir, input.path)
      if (rel === '') throw new TypeError('path must name a file')
      if (typeof input.content !== 'string') throw new TypeError('content must be a string')
      const bytes = Buffer.byteLength(input.content)
      if (bytes > MAX_WRITE_BYTES) throw new TypeError(`content is ${bytes} bytes; the limit is ${MAX_WRITE_BYTES}`)
      // The approval card shows what will be written (truncated), so the user approves the content, not just a path.
      return { kind: 'file.write', target: rel, summary: `write ${rel} (${bytes} bytes)`, detail: { preview: input.content.slice(0, 2000) } }
    },
    async run(input) {
      try {
        if (!isRecord(input) || typeof input.content !== 'string') throw new TypeError('input must have string path and content')
        const { abs } = confine(workdir, input.path)
        await assertInside(workdir, abs)
        const existing = await lstat(abs).catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return undefined
          throw err
        })
        if (existing && !existing.isFile()) throw new Error('target exists and is not a regular file (symlinks are not followed)')
        await mkdir(path.dirname(abs), { recursive: true })
        await assertInside(workdir, path.dirname(abs))
        const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(6).toString('hex')}.tmp`)
        await writeFile(tmp, input.content, { flag: 'wx' })
        await rename(tmp, abs)
        return result(`wrote ${Buffer.byteLength(input.content)} bytes to ${confine(workdir, input.path).rel}`)
      } catch (err) {
        return result(`write_file failed: ${errorText(err)}`, true)
      }
    },
  }

  return [listFiles, readFileTool, writeFileTool]
}

/** Per-agent plugin (catalog name 'workspace'). */
export const Workspace = {
  name: 'workspace',
  inject: ['agent', 'tools'],
  apply(ctx: Context, config: WorkspaceConfig = {}): void {
    const dataDir = ctx.get('config')?.dataDir
    const workdir = config.dir ?? ctx.agent.spec.workdir ?? (dataDir === undefined ? undefined : path.join(dataDir, 'workspaces', ctx.agent.id))
    if (workdir === undefined || !path.isAbsolute(workdir)) throw new TypeError('workspace: needs an absolute dir (config.dir, spec.workdir or app config)')
    mkdirSync(workdir, { recursive: true })
    for (const tool of makeWorkspaceTools(workdir)) ctx.tools.register(tool)
  },
}
