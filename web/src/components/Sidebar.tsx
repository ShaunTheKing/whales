import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentView, Room } from '../types.ts'
import { plainPreview, shortTime } from '../lib/format.ts'
import { Avatar } from './Avatar.tsx'

export type Selection =
  | { kind: 'agent'; id: string }
  | { kind: 'room'; id: string }
  | { kind: 'new-agent' }
  | { kind: 'new-room' }
  | { kind: 'market' }
  | { kind: 'models' }
  | undefined

interface Conversation {
  kind: 'agent' | 'room'
  id: string
  name: string
  preview: string
  at: number | undefined
  state?: AgentView['state']
}

function conversations(agents: AgentView[], rooms: Room[]): Conversation[] {
  const nameOf = (id: string) => (id === 'user' ? 'You' : (agents.find((a) => a.id === id)?.name ?? id))
  const list: Conversation[] = [
    ...agents.map((agent): Conversation => ({
      kind: 'agent',
      id: agent.id,
      name: agent.name,
      preview: agent.last ? `${agent.last.from === 'user' ? 'You: ' : ''}${plainPreview(agent.last.text)}` : (agent.role ?? 'No messages yet'),
      at: agent.last?.at,
      state: agent.state,
    })),
    ...rooms.map((room): Conversation => ({
      kind: 'room',
      id: room.id,
      name: room.name,
      preview: room.last ? `${nameOf(room.last.from)}: ${plainPreview(room.last.text)}` : `${room.members.length} members`,
      at: room.last?.at ?? room.createdAt,
    })),
  ]
  // Most recent first; conversations without messages keep a stable alphabetical order at the end.
  return list.sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.name.localeCompare(b.name))
}

export function Sidebar(props: {
  agents: AgentView[]
  rooms: Room[]
  selection: Selection
  pendingApprovals: number
  status: 'connecting' | 'open' | 'closed' | 'unauthorized'
  onSelect(selection: Selection): void
}) {
  const { agents, rooms, selection, pendingApprovals, status, onSelect } = props
  const [query, setQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [menuOpen])

  const list = useMemo(() => {
    const all = conversations(agents, rooms)
    const q = query.trim().toLowerCase()
    return q ? all.filter((c) => c.name.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q)) : all
  }, [agents, rooms, query])

  const statusLabel =
    status === 'open' ? 'Connected' : status === 'connecting' ? 'Connecting…' : status === 'unauthorized' ? 'Signed out' : 'Offline'
  const isSelected = (c: Conversation) => selection?.kind === c.kind && selection.id === c.id
  const navClass = (active: boolean) => (active ? 'nav-item nav-item-active' : 'nav-item')

  const choose = (next: Selection) => {
    setMenuOpen(false)
    onSelect(next)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="wordmark">Whales</div>
        <div className="menu-anchor" ref={menuRef}>
          <button
            type="button"
            className="icon-btn"
            title="New"
            aria-label="New agent or room"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M7 1.5v11M1.5 7h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          {menuOpen ? (
            <div className="menu" role="menu">
              <button type="button" role="menuitem" className="menu-item" onClick={() => choose({ kind: 'new-agent' })}>
                New agent
                <span className="muted small">a chat with one AI</span>
              </button>
              <button type="button" role="menuitem" className="menu-item" onClick={() => choose({ kind: 'new-room' })}>
                New room
                <span className="muted small">several agents together</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <label className="search">
        <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
          <circle cx="5.5" cy="5.5" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8.7 8.7 12 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" aria-label="Search conversations" />
      </label>

      <div className="conv-list" role="list">
        {list.length === 0 ? (
          <div className="nav-empty">
            {query ? 'No matches.' : 'No conversations yet. Press + to create an agent.'}
          </div>
        ) : (
          list.map((c) => (
            <button
              key={`${c.kind}:${c.id}`}
              type="button"
              role="listitem"
              className={isSelected(c) ? 'conv conv-active' : 'conv'}
              onClick={() => onSelect({ kind: c.kind, id: c.id })}
            >
              <span className="conv-avatar">
                <Avatar id={c.id} name={c.name} kind={c.kind} size={38} />
                {c.kind === 'agent' && c.state !== 'active' ? <span className={c.state === 'failed' ? 'presence presence-failed' : 'presence'} /> : null}
              </span>
              <span className="conv-main">
                <span className="conv-top">
                  <span className="conv-name">{c.name}</span>
                  {c.at ? <span className="conv-time">{shortTime(c.at)}</span> : null}
                </span>
                <span className="conv-preview">{c.preview}</span>
              </span>
            </button>
          ))
        )}
      </div>

      <div className="sidebar-footer">
        <button type="button" className={navClass(selection?.kind === 'models')} onClick={() => onSelect({ kind: 'models' })}>
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
            <circle cx="7.5" cy="7.5" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="7.5" cy="7.5" r="2.25" fill="currentColor" />
          </svg>
          <span>Models</span>
        </button>
        <button type="button" className={navClass(selection?.kind === 'market')} onClick={() => onSelect({ kind: 'market' })}>
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
            <rect x="1.5" y="1.5" width="5" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <rect x="8.5" y="1.5" width="5" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <rect x="1.5" y="8.5" width="5" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <rect x="8.5" y="8.5" width="5" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          <span>Plugins</span>
        </button>
        <div className="status-line">
          <span className={status === 'open' ? 'dot dot-active' : status === 'unauthorized' ? 'dot dot-failed' : 'dot dot-stopped'} />
          <span>{statusLabel}</span>
          {pendingApprovals > 0 ? <span className="badge badge-warn">{pendingApprovals} waiting</span> : null}
        </div>
      </div>
    </aside>
  )
}
