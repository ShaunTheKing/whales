import type { AgentView, Room } from '../types.ts'

export type Selection =
  | { kind: 'agent'; id: string }
  | { kind: 'room'; id: string }
  | { kind: 'new-agent' }
  | { kind: 'new-room' }
  | { kind: 'market' }
  | { kind: 'models' }
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
    status === 'open' ? 'Connected' : status === 'connecting' ? 'Connecting…' : status === 'unauthorized' ? 'Unauthorized' : 'Disconnected'
  const statusDot = status === 'open' ? 'dot dot-active' : status === 'unauthorized' ? 'dot dot-failed' : 'dot dot-stopped'
  const itemClass = (active: boolean) => (active ? 'nav-item nav-item-active' : 'nav-item')

  return (
    <aside className="sidebar">
      <div className="wordmark">
        <span className="wordmark-dots">
          <span />
          <span />
          <span />
        </span>
        Whales
      </div>
      <div className="tagline">Local multi-agent workspace</div>

      <button type="button" className="nav-primary" onClick={() => onSelect({ kind: 'new-agent' })}>
        <span aria-hidden="true">+</span> New agent
      </button>

      <div className="nav-section">
        <div className="nav-label">
          <span>Agents</span>
          <button type="button" className="nav-add" title="New agent" onClick={() => onSelect({ kind: 'new-agent' })}>
            +
          </button>
        </div>
        {agents.length === 0 ? (
          <div className="nav-empty">No agents yet.</div>
        ) : (
          <ul>
            {agents.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  className={itemClass(selection?.kind === 'agent' && selection.id === agent.id)}
                  onClick={() => onSelect({ kind: 'agent', id: agent.id })}
                >
                  <span className={dotClass(agent.state)} />
                  <span>{agent.name}</span>
                  <span className="muted">{agent.role ?? agent.driver.model ?? ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="nav-section">
        <div className="nav-label">
          <span>Rooms</span>
          <button type="button" className="nav-add" title="New room" onClick={() => onSelect({ kind: 'new-room' })}>
            +
          </button>
        </div>
        {rooms.length === 0 ? (
          <div className="nav-empty">No rooms yet.</div>
        ) : (
          <ul>
            {rooms.map((room) => (
              <li key={room.id}>
                <button
                  type="button"
                  className={itemClass(selection?.kind === 'room' && selection.id === room.id)}
                  onClick={() => onSelect({ kind: 'room', id: room.id })}
                >
                  <span aria-hidden="true">#</span>
                  <span>{room.name}</span>
                  <span className="muted">{room.members.length}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sidebar-footer">
        <button type="button" className={itemClass(selection?.kind === 'models')} onClick={() => onSelect({ kind: 'models' })}>
          <span aria-hidden="true">◎</span>
          <span>Models</span>
        </button>
        <button type="button" className={itemClass(selection?.kind === 'market')} onClick={() => onSelect({ kind: 'market' })}>
          <span aria-hidden="true">⊞</span>
          <span>Marketplace</span>
        </button>
        <div className="status-line">
          <span className={statusDot} />
          <span>{statusLabel}</span>
          {pendingApprovals > 0 ? <span className="badge badge-warn">{pendingApprovals} waiting</span> : null}
        </div>
      </div>
    </aside>
  )
}
