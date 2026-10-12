import type { Action, PermissionMode } from './core.ts'
import type { BaseRecord } from './store.ts'

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny'
export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'expired' | 'cancelled'

/** Scope is `agent:<action.agentId>`. Persisted for audit. */
export interface ApprovalRequest extends BaseRecord {
  scope: `agent:${string}`
  action: Action
  /** From RuleEvaluation.reason. */
  reason: string
  status: ApprovalStatus
  decision?: ApprovalDecision
  decidedAt?: number
  note?: string
}

export interface Authorization {
  allowed: boolean
  via: 'rule' | 'user' | 'cancelled'
  reason: string
  requestId?: string
}

export interface ApprovalsService {
  /**
   * The single gate every side effect goes through.
   * rules.evaluate → allow/deny immediately, or enqueue a request and block until `answer`.
   * Aborting `signal` cancels the request (status `cancelled`, allowed=false). No timeout by default.
   * `allow-always` also adds an agent-scoped allow rule for exactly this kind + target.
   */
  authorize(action: Action, opts: { mode: PermissionMode; signal?: AbortSignal }): Promise<Authorization>
  pending(): ApprovalRequest[]
  get(id: string): ApprovalRequest | undefined
  /** Returns false if the request is unknown or no longer pending. Only user surfaces call this. */
  answer(id: string, decision: ApprovalDecision, note?: string): boolean
}

declare module './store.ts' {
  interface Collections {
    approvals: ApprovalRequest
  }
}

declare module 'cordis' {
  interface Context {
    approvals: ApprovalsService
  }
}
