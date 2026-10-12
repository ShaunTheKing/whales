import { useCallback, useEffect, useRef, useState } from 'react'
import { api, hasToken, subscribe } from './api.ts'
import type { AgentView, ApprovalRequest, Room, ServerEvent } from './types.ts'
import { Sidebar, type Selection } from './components/Sidebar.tsx'
import { NewAgentForm } from './components/NewAgentForm.tsx'
import { NewRoomForm } from './components/NewRoomForm.tsx'
import { TokenGate } from './components/TokenGate.tsx'
import { ChatView } from './components/ChatView.tsx'
import { RoomView } from './components/RoomView.tsx'
import { ApprovalTray } from './components/ApprovalTray.tsx'
import { MarketView } from './components/MarketView.tsx'
import { ModelsView } from './components/ModelsView.tsx'

type Status = 'connecting' | 'open' | 'closed' | 'unauthorized'

export default function App() {
  const [authed, setAuthed] = useState<boolean>(hasToken())
  const [status, setStatus] = useState<Status>('connecting')
  const [agents, setAgents] = useState<AgentView[]>([])
  const [rooms, setRooms] = useState<Room[]>([])
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [selection, setSelection] = useState<Selection>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const loadAgents = useCallback(async () => {
    try {
      const list = await api.agents()
      if (mounted.current) setAgents(list)
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const loadRooms = useCallback(async () => {
    try {
      const list = await api.rooms()
      if (mounted.current) setRooms(list)
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const loadApprovals = useCallback(async () => {
    try {
      const list = await api.approvals()
      if (mounted.current) setApprovals(list.filter((a) => a.status === 'pending'))
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    if (!authed) return
    let cancelled = false
    setLoading(true)
    setError(undefined)
    void Promise.all([api.agents(), api.rooms(), api.approvals()])
      .then(([agentList, roomList, approvalList]) => {
        if (cancelled) return
        setAgents(agentList)
        setRooms(roomList)
        setApprovals(approvalList.filter((a) => a.status === 'pending'))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [authed])

  useEffect(() => {
    if (!authed) return
    const unsubscribe = subscribe(
      (event: ServerEvent) => {
        switch (event.type) {
          case 'agent-spawned':
          case 'agent-disposed':
            void loadAgents()
            break
          case 'approval-requested':
            setApprovals((prev) => {
              if (prev.some((a) => a.id === event.data.id)) return prev
              return [...prev, event.data]
            })
            break
          case 'approval-resolved':
            setApprovals((prev) => prev.filter((a) => a.id !== event.data.id))
            break
          default:
            break
        }
      },
      (next) => {
        setStatus(next)
        if (next === 'unauthorized') setAuthed(false)
      },
    )
    return unsubscribe
  }, [authed, loadAgents])

  const handleToken = useCallback(() => {
    setAuthed(true)
  }, [])

  const handleAgentCreated = useCallback(
    (agent: AgentView) => {
      setAgents((prev) => {
        const rest = prev.filter((a) => a.id !== agent.id)
        return [...rest, agent]
      })
      setSelection({ kind: 'agent', id: agent.id })
    },
    [],
  )

  const handleRoomCreated = useCallback((room: Room) => {
    setRooms((prev) => {
      const rest = prev.filter((r) => r.id !== room.id)
      return [...rest, room]
    })
    setSelection({ kind: 'room', id: room.id })
  }, [])

  const handleRoomDeleted = useCallback(() => {
    setSelection(undefined)
    void loadRooms()
  }, [loadRooms])

  const handleAgentChanged = useCallback(() => {
    void loadAgents()
  }, [loadAgents])

  const handleApprovalAnswered = useCallback((id: string) => {
    setApprovals((prev) => prev.filter((a) => a.id !== id))
  }, [])

  if (!authed) {
    return <TokenGate onToken={handleToken} />
  }

  const selectedAgent =
    selection?.kind === 'agent' ? agents.find((a) => a.id === selection.id) : undefined

  return (
    <div className="app">
      <Sidebar
        agents={agents}
        rooms={rooms}
        selection={selection}
        pendingApprovals={approvals.length}
        status={status}
        onSelect={setSelection}
      />
      <main className="main">
        {error ? <div className="error">{error}</div> : null}
        {selection?.kind === 'agent' && selectedAgent ? (
          <ChatView agent={selectedAgent} onChanged={handleAgentChanged} onOpenMarket={() => setSelection({ kind: 'market' })} />
        ) : null}
        {selection?.kind === 'agent' && !selectedAgent ? (
          <div className="empty">Agent not found.</div>
        ) : null}
        {selection?.kind === 'room' ? (
          <RoomView roomId={selection.id} agents={agents} onDeleted={handleRoomDeleted} onOpenMarket={() => setSelection({ kind: 'market' })} />
        ) : null}
        {selection?.kind === 'new-agent' ? (
          <NewAgentForm onCreated={handleAgentCreated} onCancel={() => setSelection(undefined)} onOpenModels={() => setSelection({ kind: 'models' })} />
        ) : null}
        {selection?.kind === 'new-room' ? (
          <NewRoomForm agents={agents} onCreated={handleRoomCreated} onCancel={() => setSelection(undefined)} />
        ) : null}
        {selection?.kind === 'market' ? <MarketView onChanged={handleAgentChanged} /> : null}
        {selection?.kind === 'models' ? <ModelsView onChanged={handleAgentChanged} /> : null}
        {selection === undefined ? (
          <div className="empty">
            {loading ? (
              'Loading…'
            ) : (
              <>
                <h2>Welcome to Whales</h2>
                <p>Create an agent to start a chat, put several agents in a room to work together, and add plugins from the Marketplace.</p>
                <div className="row" style={{ justifyContent: 'center' }}>
                  <button type="button" className="btn btn-primary" onClick={() => setSelection({ kind: 'new-agent' })}>
                    New agent
                  </button>
                  <button type="button" className="btn" onClick={() => setSelection({ kind: 'market' })}>
                    Browse plugins
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}
      </main>
      {approvals.length > 0 ? (
        <ApprovalTray approvals={approvals} agents={agents} onAnswered={handleApprovalAnswered} />
      ) : null}
    </div>
  )
}
