import { useCallback, useState } from 'react'
import type { JSX } from 'react'
import { api } from '../api.ts'
import type { ApprovalDecision, ApprovalRequest, AgentView } from '../types.ts'

function previewOf(detail: unknown): string | undefined {
  if (typeof detail !== 'object' || detail === null) return undefined
  const value = (detail as Record<string, unknown>).preview
  return typeof value === 'string' ? value : undefined
}

function hiresOf(detail: unknown): string[] | undefined {
  if (typeof detail !== 'object' || detail === null) return undefined
  const value = (detail as Record<string, unknown>).hires
  if (!Array.isArray(value)) return undefined
  return value.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
}

export function ApprovalTray(props: { approvals: ApprovalRequest[]; agents: AgentView[]; onAnswered(id: string): void }) {
  const { approvals, agents, onAnswered } = props
  const [errors, setErrors] = useState<Record<string, string>>({})

  const answer = useCallback(
    async (id: string, decision: ApprovalDecision) => {
      setErrors((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      try {
        await api.answer(id, decision)
        onAnswered(id)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        setErrors((prev) => ({ ...prev, [id]: message }))
      }
    },
    [onAnswered],
  )

  if (approvals.length === 0) return <div className="approval-tray" />

  return (
    <div className="approval-tray">
      {approvals.map((request) => {
        const agent = agents.find((candidate) => candidate.id === request.action.agentId)
        const preview = previewOf(request.action.detail)
        const hires = hiresOf(request.action.detail)
        const error = errors[request.id]
        return (
          <div key={request.id} className="approval-card">
            <div className="msg-head">
              <strong>{agent ? agent.name : request.action.agentId}</strong>
              <span className="badge">{request.action.kind}</span>
              <span className="badge">{request.action.target}</span>
            </div>
            <div>{request.action.summary}</div>
            <div className="muted">{request.reason}</div>
            {preview ? <pre className="approval-detail">{preview}</pre> : null}
            {hires ? (
              <ul>
                {hires.map((hire, index) => (
                  <li key={`${request.id}-${index}`}>{hire}</li>
                ))}
              </ul>
            ) : null}
            {error ? <div className="error">{error}</div> : null}
            <div className="row">
              <button className="btn-primary" type="button" onClick={() => void answer(request.id, 'allow-once')}>
                Allow once
              </button>
              <button className="btn" type="button" onClick={() => void answer(request.id, 'allow-always')}>
                Always allow
              </button>
              <button className="btn-danger" type="button" onClick={() => void answer(request.id, 'deny')}>
                Deny
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
