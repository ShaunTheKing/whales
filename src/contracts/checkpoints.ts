import type { AgentId, TurnId } from './core.ts'
import type { BaseRecord } from './store.ts'

export interface Checkpoint extends BaseRecord {
  scope: `agent:${AgentId}`
  agentId: AgentId
  turnId?: TurnId
  phase: 'before' | 'after' | 'manual'
  label: string
  /** Commit id in the agent's shadow repository. */
  ref: string
}

export interface FileChange {
  /** Relative to the agent workdir. */
  path: string
  status: 'added' | 'modified' | 'deleted'
}

/**
 * Root `checkpoints` service. Uses a shadow git repository per agent
 * (`--git-dir <dataDir>/checkpoints/<agentId>.git --work-tree <workdir>`), so the agent's own
 * `.git` is never touched. Hooks `whales/turn-before` / `whales/turn-after` for agents whose spec
 * includes the `checkpoints` plugin ref. Implemented/reviewed by the orchestrator only.
 */
export interface CheckpointsService {
  snapshot(agentId: AgentId, label: string, phase?: Checkpoint['phase'], turnId?: TurnId): Promise<Checkpoint>
  list(agentId: AgentId): Checkpoint[]
  get(id: string): Checkpoint | undefined
  diff(fromId: string, toId?: string): Promise<{ changes: FileChange[]; patch: string }>
  /** Restores the workdir to the checkpoint. Takes a `manual` safety snapshot first. Gated by approvals. */
  restore(id: string, opts?: { signal?: AbortSignal }): Promise<Checkpoint>
}

declare module './store.ts' {
  interface Collections {
    checkpoints: Checkpoint
  }
}

declare module 'cordis' {
  interface Context {
    checkpoints: CheckpointsService
  }
}
