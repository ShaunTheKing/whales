import { useState } from 'react'
import { api, ApiError } from '../api.ts'
import type { AgentView, Room } from '../types.ts'

export function NewRoomForm(props: {
  agents: AgentView[]
  onCreated(room: Room): void
  onCancel(): void
}) {
  const { agents, onCreated, onCancel } = props
  const [name, setName] = useState('')
  const [members, setMembers] = useState<string[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const toggle = (id: string): void => {
    setMembers((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]))
  }

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setError(undefined)
    if (members.length === 0) {
      setError('Select at least one agent.')
      return
    }
    setBusy(true)
    try {
      const room = await api.createRoom(name.trim(), members)
      onCreated(room)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span>New room</span>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className="panel-body">
        <form className="form" onSubmit={(e) => void submit(e)}>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <div className="field">
            <span>Members</span>
            {agents.length === 0 ? (
              <div className="empty">No agents available.</div>
            ) : (
              agents.map((agent) => (
                <label key={agent.id} className="row">
                  <input
                    type="checkbox"
                    checked={members.includes(agent.id)}
                    onChange={() => toggle(agent.id)}
                  />
                  <span>{agent.name}</span>
                  <span className="muted">{agent.role ?? ''}</span>
                </label>
              ))
            )}
          </div>
          {error ? <div className="error">{error}</div> : null}
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create room'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
