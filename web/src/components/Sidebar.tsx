import type { AgentView, Room } from '../types.ts'

export type Selection =
  | { kind: 'agent'; id: string }
  | { kind: 'room'; id: string }
  | { kind: 'new-agent' }
  | { kind: 'new-room' }
  | undefined

export function Sidebar(props: {
  agents: AgentView[]
  rooms: Room[]
  selection: Selection
  pendingApprovals: number
  status: 'connecting' | 'open' | 'closed' | 'unauthorized'
  onSelect(selection: Selection): void
}) {
  const { agents, rooms, selection, pendingApprovals, status, onSelect } = props

  const dotClass = (state: AgentView['state']): string => {
    if (state === 'active') return 'dot dot-active'
    if (state === 'failed') return 'dot dot-failed'
    return 'dot dot-stopped'
  }

  const statusLabel =
    status === 'open'
      ? 'Connected'
      : status === 'connecting'
        ? 'Connecting…'
        : status === 'unauthorized'
          ? 'Unauthorized'
          : 'Disconnected'

  return (
    <aside className="sidebar">
      <div className="panel-head">
        <span>Whales</span>
      </div>
      <div className="panel-body">
        <div className="row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onSelect({ kind: 'new-agent' })}
          >
            + Agent
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onSelect({ kind: 'new-room' })}
          >
            + Room
          </button>
        </div>

        <h3 className="muted">Agents</h3>
        {agents.length === 0 ? (
          <div className="empty">No agents yet.</div>
        ) : (
          <ul>
            {agents.map((agent) => {
              const active = selection?.kind === 'agent' && selection.id === agent.id
              return (
                <li key={agent.id}>
                  <button
                    type="button"
                    className={active ? 'btn btn-primary' : 'btn btn-ghost'}
                    onClick={() => onSelect({ kind: 'agent', id: agent.id })}
                  >
                    <span className={dotClass(agent.state)} />
                    <span>{agent.name}</span>
                    <span className="muted">{agent.role ?? agent.driver.model ?? ''}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        <h3 className="muted">Rooms</h3>
        {rooms.length === 0 ? (
          <div className="empty">No rooms yet.</div>
        ) : (
          <ul>
            {rooms.map((room) => {
              const active = selection?.kind === 'room' && selection.id === room.id
              return (
                <li key={room.id}>
                  <button
                    type="button"
                    className={active ? 'btn btn-primary' : 'btn btn-ghost'}
                    onClick={() => onSelect({ kind: 'room', id: room.id })}
                  >
                    <span>{room.name}</span>
                    <span className="muted">{room.members.length}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <div className="panel-head">
        <span className="muted">{statusLabel}</span>
        {pendingApprovals > 0 ? <span className="badge">{pendingApprovals}</span> : null}
      </div>
    </aside>
  )
}
