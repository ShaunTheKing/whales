import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { api, ApiError } from '../api.ts'
import type { AgentView, DriverEvent, Room, RoomMessage } from '../types.ts'
import { ToolCallView } from './ToolCallView.tsx'
import { PluginPicker } from './PluginPicker.tsx'

interface ToolState {
  id: string
  name: string
  input: unknown
  result?: { output: string; isError: boolean }
}

interface LiveBlock {
  key: string
  speaker: string
  arbiter: boolean
  content: string
  tools: ToolState[]
}

function applyEvent(block: LiveBlock, event: DriverEvent): LiveBlock {
  switch (event.type) {
    case 'text':
      return { ...block, content: block.content + event.delta }
    case 'tool_call':
      return {
        ...block,
        content: block.content && !/\s$/.test(block.content) ? `${block.content}\n\n` : block.content,
        tools: [...block.tools, { id: event.id, name: event.name, input: event.input }],
      }
    case 'tool_result':
      return {
        ...block,
        tools: block.tools.map((tool) =>
          tool.id === event.id ? { ...tool, result: { output: event.output, isError: event.isError } } : tool,
        ),
      }
    default:
      return block
  }
}

export function RoomView(props: { roomId: string; agents: AgentView[]; onDeleted(): void; onOpenMarket(): void }) {
  const { roomId, agents, onDeleted, onOpenMarket } = props
  const [showPlugins, setShowPlugins] = useState(false)
  const [room, setRoom] = useState<Room | undefined>(undefined)
  const [order, setOrder] = useState<string[]>([])
  const [history, setHistory] = useState<RoomMessage[]>([])
  const [live, setLive] = useState<LiveBlock[]>([])
  const [round, setRound] = useState<number | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [streaming, setStreaming] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [note, setNote] = useState('')
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const reloadRoom = useCallback(async () => {
    try {
      const data = await api.room(roomId)
      setRoom(data.room)
      setOrder(data.order)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [roomId])

  const nameOf = useCallback(
    (id: string): string => {
      if (id === 'user') return 'You'
      const agent = agents.find((candidate) => candidate.id === id)
      return agent ? agent.name : id
    },
    [agents],
  )

  useEffect(() => {
    let cancelled = false
    setRoom(undefined)
    setOrder([])
    setHistory([])
    setLive([])
    setRound(undefined)
    setError(undefined)
    api
      .room(roomId)
      .then((data) => {
        if (cancelled) return
        setRoom(data.room)
        setOrder(data.order)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    api
      .roomMessages(roomId)
      .then((messages) => {
        if (!cancelled) setHistory(messages)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
      controllerRef.current?.abort()
      controllerRef.current = undefined
    }
  }, [roomId])

  useEffect(() => {
    const body = bodyRef.current
    if (body) body.scrollTop = body.scrollHeight
  }, [history, live])

  const post = useCallback(async () => {
    const text = prompt.trim()
    if (!text || streaming) return
    setPrompt('')
    setError(undefined)
    setHistory((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, speaker: 'user', content: text, round: round ?? 0, createdAt: Date.now() },
    ])
    setStreaming(true)
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      for await (const event of api.post(roomId, text, controller.signal)) {
        switch (event.type) {
          case 'round-start':
            setRound(event.round)
            setLive([])
            break
          case 'speaker':
            setLive((prev) => [
              ...prev,
              { key: `${event.agentId}-${event.position}-${Date.now()}`, speaker: event.agentId, arbiter: event.arbiter, content: '', tools: [] },
            ])
            break
          case 'agent':
            if (event.event.type === 'error') {
              setError(event.event.message)
              break
            }
            setLive((prev) => {
              if (prev.length === 0) return prev
              const next = [...prev]
              const last = next[next.length - 1]
              if (!last) return prev
              next[next.length - 1] = applyEvent(last, event.event)
              return next
            })
            break
          case 'message':
            setHistory((prev) => [...prev, event.message])
            break
          case 'skipped':
            setHistory((prev) => [
              ...prev,
              {
                id: `skip-${Date.now()}-${event.agentId}`,
                speaker: 'system',
                content: `${nameOf(event.agentId)} skipped: ${event.reason}`,
                round: round ?? 0,
                createdAt: Date.now(),
              },
            ])
            break
          case 'round-end':
            setLive([])
            break
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('cancelled')
      } else if (err instanceof ApiError) {
        setError(err.message)
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError(String(err))
      }
    } finally {
      controllerRef.current = undefined
      setStreaming(false)
      setLive([])
      api
        .roomMessages(roomId)
        .then(setHistory)
        .catch(() => undefined)
    }
  }, [nameOf, prompt, roomId, round, streaming])

  const stop = useCallback(() => {
    controllerRef.current?.abort()
  }, [])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void post()
      }
    },
    [post],
  )

  const addNote = useCallback(async () => {
    const text = note.trim()
    if (!text) return
    setError(undefined)
    try {
      await api.addNote(roomId, text)
      setNote('')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [note, roomId])

  const remove = useCallback(async () => {
    if (!window.confirm(`Delete room "${room?.name ?? roomId}"?`)) return
    setError(undefined)
    try {
      await api.deleteRoom(roomId)
      onDeleted()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [onDeleted, room?.name, roomId])

  const members = order.length > 0 ? order : (room?.members ?? [])
  let lastRound: number | undefined

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="title-block">
          <strong># {room?.name ?? roomId}</strong>
          <span>
            {members.map((id, index) => (
              <span key={id}>
                {index > 0 ? ' · ' : ''}
                {nameOf(id)}
                {index === members.length - 1 ? ' (arbiter)' : ''}
              </span>
            ))}
            {room?.plugins?.length ? ` · ${room.plugins.length} plugin${room.plugins.length === 1 ? '' : 's'}` : ''}
          </span>
        </div>
        <div className="header-actions">
          <input className="input" style={{ width: 180 }} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a shared note…" />
          <button className="btn btn-sm" type="button" onClick={() => void addNote()} disabled={note.trim().length === 0}>
            Add note
          </button>
          <button className="btn btn-sm" type="button" onClick={() => setShowPlugins(true)}>
            Plugins
          </button>
          <button className="btn btn-danger btn-sm" type="button" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      </div>
      {showPlugins && room ? (
        <PluginPicker
          target={{ kind: 'room', id: room.id, name: room.name }}
          onClose={() => setShowPlugins(false)}
          onChanged={() => void reloadRoom()}
          onOpenMarket={onOpenMarket}
        />
      ) : null}
      <div className="panel-body" ref={bodyRef}>
        <div className="messages">
          {history.map((message) => {
            const separator = message.round !== lastRound ? <div key={`sep-${message.id}`} className="round-sep">Round {message.round}</div> : null
            lastRound = message.round
            const speaker = message.speaker === 'user' ? 'You' : nameOf(message.speaker)
            const className =
              message.speaker === 'system' ? 'msg msg-system muted' : message.speaker === 'user' ? 'msg msg-user' : 'msg msg-agent'
            return (
              <Fragment key={message.id}>
                {separator}
                <div className={className}>
                  {/* The most senior member (last in speaking order) is the room's arbiter. */}
                  <div className={message.speaker === order.at(-1) ? 'msg-head speaker-arbiter' : 'msg-head'}>
                    {speaker}
                    {message.speaker === order.at(-1) ? <span className="badge">arbiter</span> : null}
                  </div>
                  <div className="msg-body">{message.content}</div>
                </div>
              </Fragment>
            )
          })}
          {live.map((block) => (
            <div key={block.key} className="msg msg-agent">
              <div className={block.arbiter ? 'msg-head speaker-arbiter' : 'msg-head'}>
                {nameOf(block.speaker)}
                {block.arbiter ? <span className="badge">arbiter</span> : null}
              </div>
              <div className="msg-body">{block.content}</div>
              {block.tools.map((tool) => (
                <ToolCallView key={tool.id} name={tool.name} input={tool.input} result={tool.result} />
              ))}
            </div>
          ))}
          {error ? <div className="msg msg-system error">{error}</div> : null}
        </div>
      </div>
      <div className="composer">
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Post to the room…"
          rows={1}
        />
        {streaming ? (
          <button className="btn btn-sm" type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="send-btn" type="button" aria-label="Post" title="Post" onClick={() => void post()} disabled={prompt.trim().length === 0}>
            ↑
          </button>
        )}
      </div>
    </div>
  )
}
