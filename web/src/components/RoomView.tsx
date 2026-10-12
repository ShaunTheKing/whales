import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api.ts'
import type { AgentView, DriverEvent, Room, RoomMessage, RoomNote } from '../types.ts'
import { dividerTime, needsDivider } from '../lib/format.ts'
import { Markdown } from '../lib/markdown.tsx'
import { Avatar } from './Avatar.tsx'
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

const DETAILS_KEY = 'whales.details.open'

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

function readDetailsPref(): boolean {
  try {
    return localStorage.getItem(DETAILS_KEY) === '1'
  } catch {
    return false
  }
}

function writeDetailsPref(open: boolean): void {
  try {
    localStorage.setItem(DETAILS_KEY, open ? '1' : '0')
  } catch {
    // Storage unavailable: the panel just does not remember its state.
  }
}

export function RoomView(props: { roomId: string; agents: AgentView[]; onDeleted(): void; onOpenMarket(): void; onChanged?(): void }) {
  const { roomId, agents, onDeleted, onOpenMarket, onChanged } = props
  const [room, setRoom] = useState<Room | undefined>(undefined)
  const [order, setOrder] = useState<string[]>([])
  const [notes, setNotes] = useState<RoomNote[]>([])
  const [history, setHistory] = useState<RoomMessage[]>([])
  const [live, setLive] = useState<LiveBlock[]>([])
  const [round, setRound] = useState<number | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [streaming, setStreaming] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [note, setNote] = useState('')
  const [showDetails, setShowDetails] = useState(readDetailsPref)
  const [showPlugins, setShowPlugins] = useState(false)
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const nameOf = useCallback(
    (id: string): string => {
      if (id === 'user') return 'You'
      const agent = agents.find((candidate) => candidate.id === id)
      return agent ? agent.name : id
    },
    [agents],
  )

  const reloadRoom = useCallback(async () => {
    try {
      const data = await api.room(roomId)
      setRoom(data.room)
      setOrder(data.order)
      setNotes(data.notes)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [roomId])

  useEffect(() => {
    let cancelled = false
    setRoom(undefined)
    setOrder([])
    setNotes([])
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
        setNotes(data.notes)
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
    inputRef.current?.focus()
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

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${input.scrollHeight}px`
  }, [prompt])

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
            // The finished message replaces its live block.
            setLive((prev) => prev.filter((block) => block.speaker !== event.message.speaker))
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
        setError('Stopped')
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
      onChanged?.()
    }
  }, [nameOf, onChanged, prompt, roomId, round, streaming])

  const stop = useCallback(() => {
    controllerRef.current?.abort()
  }, [])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
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
      const saved = await api.addNote(roomId, text)
      setNotes((prev) => [...prev, saved])
      setNote('')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [note, roomId])

  const remove = useCallback(async () => {
    if (!window.confirm(`Delete room "${room?.name ?? roomId}"? Its messages and notes are removed too.`)) return
    setError(undefined)
    try {
      await api.deleteRoom(roomId)
      onDeleted()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [onDeleted, room?.name, roomId])

  const toggleDetails = useCallback(() => {
    setShowDetails((open) => {
      writeDetailsPref(!open)
      return !open
    })
  }, [])

  const members = order.length > 0 ? order : (room?.members ?? [])
  const arbiter = order.at(-1)

  // Build rows: time dividers, then bubbles; an agent's name + avatar shows once per run of consecutive messages.
  const rows: React.ReactNode[] = []
  let previousAt: number | undefined
  let previousSpeaker: string | undefined
  const pushAgentBubble = (key: string, speaker: string, content: string, tools: ToolState[], typing: boolean, isArbiter: boolean) => {
    const showName = speaker !== previousSpeaker
    rows.push(
      <div key={key} className={showName ? 'bubble-row from-agent group-start' : 'bubble-row from-agent'}>
        <div className="bubble-avatar">{showName ? <Avatar id={speaker} name={nameOf(speaker)} size={28} /> : null}</div>
        <div className="bubble-stack">
          {showName ? (
            <div className="bubble-name">
              {nameOf(speaker)}
              {isArbiter ? <span className="tag">arbiter</span> : null}
            </div>
          ) : null}
          {typing ? (
            <div className="bubble bubble-agent typing" aria-label="Thinking">
              <span />
              <span />
              <span />
            </div>
          ) : content ? (
            <div className="bubble bubble-agent bubble-md">
              <Markdown text={content} />
            </div>
          ) : null}
          {tools.length ? (
            <div className="bubble-tools">
              {tools.map((tool) => (
                <ToolCallView key={tool.id} name={tool.name} input={tool.input} result={tool.result} />
              ))}
            </div>
          ) : null}
        </div>
      </div>,
    )
    previousSpeaker = speaker
  }

  for (const message of history) {
    if (needsDivider(previousAt, message.createdAt)) {
      rows.push(
        <div key={`t-${message.id}`} className="time-divider">
          {dividerTime(message.createdAt)}
        </div>,
      )
      previousSpeaker = undefined
    }
    previousAt = message.createdAt
    if (message.speaker === 'user') {
      rows.push(
        <div key={message.id} className="bubble-row from-user">
          <div className="bubble-stack">
            <div className="bubble bubble-user">{message.content}</div>
          </div>
        </div>,
      )
      previousSpeaker = 'user'
    } else if (message.speaker === 'system') {
      rows.push(
        <div key={message.id} className="system-line">
          {message.content}
        </div>,
      )
      previousSpeaker = undefined
    } else {
      pushAgentBubble(message.id, message.speaker, message.content, [], false, message.speaker === arbiter)
    }
  }
  for (const block of live) {
    pushAgentBubble(block.key, block.speaker, block.content, block.tools, !block.content && block.tools.length === 0, block.arbiter)
  }

  return (
    <div className={showDetails ? 'chat-layout with-details' : 'chat-layout'}>
      <div className="panel">
        <div className="panel-head chat-head">
          <div className="chat-title">
            <Avatar id={roomId} name={room?.name ?? ''} kind="room" size={30} />
            <div className="title-block">
              <strong>{room?.name ?? 'Room'}</strong>
              <span>
                {members.map((id, index) => (index > 0 ? `, ${nameOf(id)}` : nameOf(id)))}
                {room?.plugins?.length ? ` · ${room.plugins.length} plugin${room.plugins.length === 1 ? '' : 's'}` : ''}
              </span>
            </div>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className={showDetails ? 'icon-btn icon-btn-on' : 'icon-btn'}
              onClick={toggleDetails}
              aria-pressed={showDetails}
              title={showDetails ? 'Hide details' : 'Show details'}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <line x1="10" y1="2.5" x2="10" y2="13.5" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </button>
          </div>
        </div>
        <div className="panel-body" ref={bodyRef}>
          <div className="messages">
            {history.length === 0 && live.length === 0 ? (
              <div className="chat-empty">
                <Avatar id={roomId} name={room?.name ?? ''} kind="room" size={56} />
                <strong>{room?.name ?? 'Room'}</strong>
                <span className="muted">
                  Post a message and each member answers in turn. {arbiter ? `${nameOf(arbiter)} speaks last and sums up.` : ''}
                </span>
              </div>
            ) : null}
            {rows}
            {error ? <div className="chat-error">{error}</div> : null}
          </div>
        </div>
        <div className="composer">
          <textarea
            ref={inputRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Message ${room?.name ?? 'the room'}`}
            rows={1}
          />
          {streaming ? (
            <button className="send-btn send-stop" type="button" aria-label="Stop" title="Stop" onClick={stop}>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <rect width="12" height="12" rx="2" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button className="send-btn" type="button" aria-label="Post" title="Post" onClick={() => void post()} disabled={prompt.trim().length === 0}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M7 12V2M7 2 2.5 6.5M7 2l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {showDetails ? (
        <aside className="details" aria-label="Room details">
          <div className="details-head">
            <span>Details</span>
            <button type="button" className="icon-btn" onClick={toggleDetails} title="Close details" aria-label="Close details">
              ×
            </button>
          </div>
          <div className="details-body">
            <div className="details-hero">
              <Avatar id={roomId} name={room?.name ?? ''} kind="room" size={56} />
              <strong>{room?.name ?? 'Room'}</strong>
              <span className="muted">{members.length} members</span>
            </div>

            <section className="details-section">
              <div className="details-label">Speaking order</div>
              <ul className="member-list">
                {members.map((id, index) => (
                  <li key={id}>
                    <Avatar id={id} name={nameOf(id)} size={24} />
                    <span className="grow">{nameOf(id)}</span>
                    {id === arbiter ? <span className="tag">arbiter</span> : <span className="muted small">{index + 1}</span>}
                  </li>
                ))}
              </ul>
            </section>

            <section className="details-section">
              <div className="details-label">
                <span>Room plugins</span>
                <button type="button" className="link-btn" onClick={() => setShowPlugins(true)}>
                  Manage
                </button>
              </div>
              {room?.plugins?.length ? (
                <div className="chips">
                  {room.plugins.map((plugin) => (
                    <span key={plugin.name} className="chip">
                      {plugin.name}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="muted small">None. Room plugins only work inside this room.</div>
              )}
            </section>

            <section className="details-section">
              <div className="details-label">Shared notes</div>
              {notes.length ? (
                <ul className="note-list">
                  {notes.map((item) => (
                    <li key={item.id}>
                      <span>{item.text}</span>
                      <span className="muted small">{item.author === 'user' ? 'You' : nameOf(item.author)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="muted small">Every member sees these notes.</div>
              )}
              <div className="note-add">
                <input
                  className="input"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void addNote()
                  }}
                  placeholder="Add a note"
                />
              </div>
            </section>

            <div className="details-foot">
              <button type="button" className="btn btn-danger btn-sm" onClick={() => void remove()}>
                Delete room
              </button>
            </div>
          </div>
        </aside>
      ) : null}

      {showPlugins && room ? (
        <PluginPicker
          target={{ kind: 'room', id: room.id, name: room.name }}
          onClose={() => setShowPlugins(false)}
          onChanged={() => void reloadRoom()}
          onOpenMarket={onOpenMarket}
        />
      ) : null}
    </div>
  )
}
