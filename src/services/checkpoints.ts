import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Service, type Context } from 'cordis'
import type { AgentId, TurnId } from '../contracts/core.ts'
import type { Checkpoint, CheckpointsService, FileChange } from '../contracts/checkpoints.ts'
import type { AgentSpec } from '../contracts/core.ts'
import { isAgentId, newId } from '../core/ids.ts'
import { GIT_OPTIONS, cleanEnv, runGit as run } from '../core/git.ts'

/**
 * SECURITY-CRITICAL (orchestrator-owned). Undo for agent workspaces via a shadow git repository per agent:
 *   <dataDir>/checkpoints/<agentId>.git  (outside the workspace, so the agent's file tools cannot reach it)
 *   --work-tree <agent workdir>
 * git runs via execFile (no shell) with a scrubbed environment (no inherited GIT_*, no global/system config), hooks
 * and fsmonitor disabled, so nothing inside the workspace can make git execute code. Restores are user actions gated by
 * approvals and always take a safety snapshot first.
 */

export interface CheckpointsConfig {
  /** Absolute. Default `<dataDir>/checkpoints`. */
  dir?: string
  /** git executable. Default 'git' (resolved via PATH). */
  git?: string
  /** Max bytes of patch text returned by diff(). Default 200 KiB. */
  maxPatchBytes?: number
}

export function workdirFor(spec: Pick<AgentSpec, 'id' | 'workdir'>, dataDir: string): string {
  return spec.workdir ?? path.join(dataDir, 'workspaces', spec.id)
}

export class Checkpoints extends Service implements CheckpointsService {
  static inject = ['store', 'agents']

  private store: Context['store']
  private agents: Context['agents']
  private own: Context
  private dir: string
  private gitBin: string
  private maxPatch: number
  private locks = new Map<AgentId, Promise<void>>()

  constructor(ctx: Context, config: CheckpointsConfig = {}) {
    super(ctx, 'checkpoints')
    this.store = ctx.store
    this.agents = ctx.agents
    this.own = ctx
    const dataDir = ctx.get('config')?.dataDir
    const dir = config.dir ?? (dataDir ? path.join(dataDir, 'checkpoints') : undefined)
    if (!dir || !path.isAbsolute(dir)) throw new TypeError('checkpoints: needs an absolute dir')
    this.dir = dir
    this.gitBin = config.git ?? 'git'
    this.maxPatch = config.maxPatchBytes ?? 200 * 1024
  }

  async snapshot(agentId: AgentId, label: string, phase: Checkpoint['phase'] = 'manual', turnId?: TurnId): Promise<Checkpoint> {
    return this.exclusive(agentId, async () => {
      const { repo, workdir } = this.paths(agentId)
      await this.ensureRepo(repo, workdir)
      await this.git(repo, workdir, ['add', '-A', '.'])
      const message = `${phase}: ${label}`.slice(0, 500)
      await this.git(repo, workdir, ['commit', '--allow-empty', '--no-verify', '-q', '-m', message])
      const ref = (await this.git(repo, workdir, ['rev-parse', 'HEAD'])).trim()
      const checkpoint: Checkpoint = {
        id: newId('ckpt'),
        scope: `agent:${agentId}`,
        createdAt: Date.now(),
        agentId,
        phase,
        label: label.slice(0, 200),
        ref,
        ...(turnId === undefined ? {} : { turnId }),
      }
      return this.store.collection('checkpoints').put(checkpoint)
    })
  }

  list(agentId: AgentId): Checkpoint[] {
    return this.store.collection('checkpoints').list({ scope: `agent:${agentId}` })
  }

  get(id: string): Checkpoint | undefined {
    return this.store.collection('checkpoints').get(id)
  }

  async diff(fromId: string, toId?: string): Promise<{ changes: FileChange[]; patch: string }> {
    const from = this.require(fromId)
    const to = toId === undefined ? undefined : this.require(toId)
    if (to && to.agentId !== from.agentId) throw new TypeError('checkpoints belong to different agents')
    const { repo, workdir } = this.paths(from.agentId)
    if (to) return this.diffRefs(repo, workdir, [from.ref, to.ref])
    // Against the current working tree, including new files: stage into a throwaway index.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'whales-idx-'))
    const index = { GIT_INDEX_FILE: path.join(tmp, 'index') }
    try {
      await this.git(repo, workdir, ['read-tree', 'HEAD'], index)
      await this.git(repo, workdir, ['add', '-A', '.'], index)
      return await this.diffRefs(repo, workdir, ['--cached', from.ref], index)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }

  async restore(id: string, opts: { signal?: AbortSignal } = {}): Promise<Checkpoint> {
    const target = this.require(id)
    const approvals = this.own.get('approvals')
    if (!approvals) throw new Error('approvals service required to restore')
    const { changes } = await this.diff(id)
    const auth = await approvals.authorize(
      {
        kind: 'file.write',
        target: '.',
        agentId: target.agentId,
        summary: `restore workspace to checkpoint "${target.label}" (${changes.length} file(s) change)`,
        detail: { checkpoint: target.id, changes },
      },
      { mode: 'strict', ...(opts.signal ? { signal: opts.signal } : {}) },
    )
    if (!auth.allowed) throw new Error(`restore not approved: ${auth.reason}`)
    const safety = await this.snapshot(target.agentId, `before restore to ${target.label}`, 'manual')
    await this.exclusive(target.agentId, async () => {
      const { repo, workdir } = this.paths(target.agentId)
      // Index == HEAD (the safety snapshot), so --reset also deletes files that did not exist at the target.
      await this.git(repo, workdir, ['read-tree', '-u', '--reset', target.ref])
      await this.git(repo, workdir, ['commit', '--allow-empty', '--no-verify', '-q', '-m', `restore: ${target.label}`])
    })
    return safety
  }

  private async diffRefs(repo: string, workdir: string, refs: string[], env: Record<string, string> = {}): Promise<{ changes: FileChange[]; patch: string }> {
    const status = await this.git(repo, workdir, ['diff', '--no-renames', '--name-status', '-z', ...refs], env)
    const parts = status.split('\0').filter(Boolean)
    const changes: FileChange[] = []
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const code = parts[i]
      const file = parts[i + 1] ?? ''
      changes.push({ path: file, status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified' })
    }
    let patch = await this.git(repo, workdir, ['diff', '--no-renames', '--no-color', '--no-ext-diff', ...refs], env)
    if (Buffer.byteLength(patch) > this.maxPatch) patch = `${patch.slice(0, this.maxPatch)}\n… patch truncated …\n`
    return { changes, patch }
  }

  private require(id: string): Checkpoint {
    const checkpoint = this.store.collection('checkpoints').get(id)
    if (!checkpoint) throw new Error(`checkpoint ${id} not found`)
    return checkpoint
  }

  private paths(agentId: AgentId): { repo: string; workdir: string } {
    if (!isAgentId(agentId)) throw new TypeError(`invalid agent id ${JSON.stringify(agentId)}`)
    const spec = this.agents.get(agentId)?.spec ?? this.store.collection('agents').get(agentId)?.spec
    const dataDir = this.own.get('config')?.dataDir
    if (!spec || !dataDir) throw new Error(`agent ${agentId} not found`)
    const workdir = workdirFor(spec, dataDir)
    if (!path.isAbsolute(workdir)) throw new TypeError('agent workdir must be absolute')
    mkdirSync(workdir, { recursive: true })
    return { repo: path.join(this.dir, `${agentId}.git`), workdir }
  }

  private async ensureRepo(repo: string, workdir: string): Promise<void> {
    if (existsSync(path.join(repo, 'HEAD'))) return
    mkdirSync(repo, { recursive: true })
    await run(this.gitBin, [...GIT_OPTIONS, '--git-dir', repo, 'init', '-q'], cleanEnv(), workdir)
    // Never snapshot a repository the agent created inside its workspace.
    mkdirSync(path.join(repo, 'info'), { recursive: true })
    writeFileSync(path.join(repo, 'info', 'exclude'), '.git\n')
  }

  private git(repo: string, workdir: string, args: string[], env: Record<string, string> = {}): Promise<string> {
    return run(this.gitBin, [...GIT_OPTIONS, '--git-dir', repo, '--work-tree', workdir, ...args], cleanEnv(env), workdir)
  }

  /** One git operation at a time per agent (the index is shared). */
  private async exclusive<T>(agentId: AgentId, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(agentId) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => (release = resolve))
    this.locks.set(agentId, previous.then(() => next))
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

/** Per-agent plugin (catalog name 'checkpoints'): snapshot the workspace before and after every turn. */
export const AgentCheckpoints = {
  name: 'agent-checkpoints',
  inject: ['agent', 'checkpoints'],
  apply(ctx: Context): void {
    const agentId = ctx.agent.id
    const checkpoints = ctx.checkpoints
    const take = async (phase: 'before' | 'after', label: string, turnId: TurnId) => {
      try {
        await checkpoints.snapshot(agentId, label, phase, turnId)
      } catch (err) {
        // A failed snapshot must not break the conversation; it is logged for the user.
        ctx.logger('checkpoints').warn('snapshot %s for %s failed: %s', phase, agentId, err instanceof Error ? err.message : String(err))
      }
    }
    ctx.on('whales/turn-before', (turn) => (turn.agentId === agentId ? take('before', turn.prompt.slice(0, 80), turn.turnId) : undefined))
    ctx.on('whales/turn-after', (turn) => (turn.agentId === agentId ? take('after', turn.prompt.slice(0, 80), turn.turnId) : undefined))
  },
}
