import { Service, type Context } from 'cordis'
import type { Action, ActionKind, PermissionMode } from '../contracts/core.ts'
import type { ApprovalDecision, ApprovalRequest, ApprovalsService, Authorization } from '../contracts/approvals.ts'
import { isAgentId, newId } from '../core/ids.ts'
import { sentenceFor } from './rules.ts'

/**
 * SECURITY-CRITICAL (orchestrator-owned). The single gate for side effects:
 * rules decide allow/deny, otherwise the request waits for a human `answer`. Fails closed: invalid actions,
 * aborts, disposal and restarts all resolve to "not allowed".
 */

const KINDS: readonly ActionKind[] = ['file.read', 'file.write', 'shell', 'network', 'tool', 'message', 'skill.install', 'agent.hire']
const MODES: readonly PermissionMode[] = ['ask', 'strict', 'trusted']
const DECISIONS: readonly ApprovalDecision[] = ['allow-once', 'allow-always', 'deny']

interface Waiter {
  resolve: (auth: Authorization) => void
  detach: () => void
}

function validateAction(action: Action): void {
  if (typeof action !== 'object' || action === null) throw new TypeError('approvals: action must be an object')
  if (!KINDS.includes(action.kind)) throw new TypeError(`approvals: unknown action kind ${JSON.stringify(action.kind)}`)
  if (!isAgentId(action.agentId)) throw new TypeError('approvals: action.agentId is invalid')
  if (typeof action.target !== 'string' || action.target.length === 0 || action.target.length > 4000) {
    throw new TypeError('approvals: action.target must be a 1..4000 character string')
  }
  if (typeof action.summary !== 'string' || action.summary.length > 500) throw new TypeError('approvals: action.summary must be a string of at most 500 characters')
  if (action.roomId !== undefined && typeof action.roomId !== 'string') throw new TypeError('approvals: action.roomId must be a string')
}

export class Approvals extends Service implements ApprovalsService {
  static inject = ['store', 'rules']

  private store: Context['store']
  private rules: Context['rules']
  private own: Context
  private waiters = new Map<string, Waiter>()

  constructor(ctx: Context) {
    super(ctx, 'approvals')
    this.store = ctx.store
    this.rules = ctx.rules
    this.own = ctx
    // Requests left pending by a previous process can never be answered: nobody is waiting for them.
    const records = this.store.collection('approvals')
    for (const request of records.list()) {
      if (request.status === 'pending') records.put({ ...request, status: 'expired', decidedAt: Date.now() })
    }
    ctx.effect(() => () => {
      for (const id of [...this.waiters.keys()]) this.settle(id, 'cancelled', 'approval service stopped')
    }, 'pending-approvals')
  }

  async authorize(action: Action, opts: { mode: PermissionMode; signal?: AbortSignal }): Promise<Authorization> {
    try {
      validateAction(action)
      if (!MODES.includes(opts.mode)) throw new TypeError(`approvals: unknown mode ${JSON.stringify(opts.mode)}`)
    } catch (err) {
      return { allowed: false, via: 'rule', reason: err instanceof Error ? err.message : String(err) }
    }
    if (opts.signal?.aborted) return { allowed: false, via: 'cancelled', reason: 'cancelled before evaluation' }

    const evaluation = this.rules.evaluate(action, opts.mode)
    if (evaluation.verdict === 'deny') return { allowed: false, via: 'rule', reason: evaluation.reason }
    if (evaluation.verdict === 'allow') return { allowed: true, via: 'rule', reason: evaluation.reason }

    const request: ApprovalRequest = {
      id: newId('appr'),
      scope: `agent:${action.agentId}`,
      createdAt: Date.now(),
      action: structuredClone(action),
      reason: evaluation.reason,
      status: 'pending',
    }
    this.store.collection('approvals').put(request)
    const decided = new Promise<Authorization>((resolve) => {
      const signal = opts.signal
      const onAbort = () => this.settle(request.id, 'cancelled', 'request was cancelled')
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.set(request.id, { resolve, detach: () => signal?.removeEventListener('abort', onAbort) })
    })
    this.own.emit('whales/approval-requested', request)
    return decided
  }

  pending(): ApprovalRequest[] {
    const records = this.store.collection('approvals')
    return [...this.waiters.keys()]
      .map((id) => records.get(id))
      .filter((request): request is ApprovalRequest => request?.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  get(id: string): ApprovalRequest | undefined {
    return this.store.collection('approvals').get(id)
  }

  answer(id: string, decision: ApprovalDecision, note?: string): boolean {
    if (!DECISIONS.includes(decision)) throw new TypeError(`approvals: unknown decision ${JSON.stringify(decision)}`)
    if (note !== undefined && (typeof note !== 'string' || note.length > 1000)) throw new TypeError('approvals: note must be a string of at most 1000 characters')
    if (!this.waiters.has(id)) return false
    return this.settle(id, decision, decision === 'deny' ? 'denied by user' : 'approved by user', note)
  }

  /** Resolves a pending request exactly once. Returns false if it was already settled. */
  private settle(id: string, outcome: ApprovalDecision | 'cancelled', reason: string, note?: string): boolean {
    const waiter = this.waiters.get(id)
    const records = this.store.collection('approvals')
    const request = records.get(id)
    if (!waiter || !request) return false
    this.waiters.delete(id)
    waiter.detach()

    const allowed = outcome === 'allow-once' || outcome === 'allow-always'
    const updated: ApprovalRequest = {
      ...request,
      status: outcome === 'cancelled' ? 'cancelled' : allowed ? 'allowed' : 'denied',
      decidedAt: Date.now(),
    }
    if (outcome !== 'cancelled') updated.decision = outcome
    if (note !== undefined) updated.note = note
    records.put(updated)

    if (outcome === 'allow-always') {
      try {
        this.rules.add(sentenceFor(request.action), `agent:${request.action.agentId}`)
      } catch (err) {
        // The user still approved this one call; only the standing rule could not be expressed.
        this.own.logger('approvals').warn('could not save allow-always rule for %s: %s', id, err instanceof Error ? err.message : String(err))
      }
    }
    this.own.emit('whales/approval-resolved', updated)
    waiter.resolve({ allowed, via: outcome === 'cancelled' ? 'cancelled' : 'user', reason, requestId: id })
    return true
  }
}
