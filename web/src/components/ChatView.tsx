import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api.ts'
import type { AgentView, DmMessage, DriverEvent } from '../types.ts'
import { dividerTime, needsDivider } from '../lib/format.ts'
import { Avatar } from './Avatar.tsx'
import { AgentDetails } from './AgentDetails.tsx'
import { ToolCallView } from './ToolCallView.tsx'

interface ToolState {
  id: string
  name: string
  input: unknown
  result?: { output: string; isError: boolean }
}

interface LiveMessage {
  role: 'user' | 'assistant'
  content: string
  tools: ToolState[]
  at: number
  usage?: { inputTokens: number; outputTokens: number }
  cancelled?: boolean
}

type Entry = LiveMessage & { id: string }

const DETAILS_KEY = 'whales.details.open'

function fromServer(message: DmMessage): Entry {
  return { id: message.id, role: message.role, content: message.content, tools: [], at: message.createdAt }
}

function applyEvent(message: LiveMessage, event: DriverEvent): LiveMessage {
  switch (event.type) {
    case 'text':
      return { ...message, content: message.content + event.delta }
    case 'tool_call':
      // Text after a tool call is a new paragraph; without a break the two rounds run together ("now.Done").
      return {
        ...message,
        content: message.content && !/\s$/.test(message.content) ? `${message.content}\n\n` : message.content,
        tools: [...message.tools, { id: event.id, name: event.name, input: event.input }],
      }
    case 'tool_result':
      return {
        ...message,
        tools: message.tools.map((tool) =>
          tool.id === event.id ? { ...tool, result: { output: event.output, isError: event.isError } } : tool,
        ),
      }
    case 'usage':
      return { ...message, usage: { inputTokens: event.inputTokens, outputTokens: event.outputTokens } }
    default:
      return message
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

function Bubble(props: { entry: Entry; live?: boolean }) {
  const { entry, live } = props
  const mine = entry.role === 'user'
  const thinking = live && !entry.content && entry.tools.length === 0
  return (
    <div className={mine ? 'bubble-row from-user' : 'bubble-row from-agent'}>
      <div className="bubble-stack">
        {thinking ? (
          <div className="bubble bubble-agent typing" aria-label="Thinking">
            <span />
            <span />
            <span />
          </div>
        ) : entry.content ? (
          <div className={mine ? 'bubble bubble-user' : 'bubble bubble-agent'}>{entry.content}</div>
        ) : null}
        {entry.tools.length ? (
          <div className="bubble-tools">
            {entry.tools.map((tool) => (
              <ToolCallView key={tool.id} name={tool.name} input={tool.input} result={tool.result} />
            ))}
          </div>
        ) : null}
        {entry.cancelled || entry.usage ? (
          <div className="bubble-meta">
            {entry.cancelled ? 'Stopped' : ''}
            {entry.cancelled && entry.usage ? ' · ' : ''}
            {entry.usage ? `${entry.usage.inputTokens} in · ${entry.usage.outputTokens} out` : ''}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function ChatView(props: { agent: AgentView; onChanged(): void; onOpenMarket(): void }) {
  const { agent, onChanged, onOpenMarket } = props
  // Server history (text only) plus turns finished in this session, which keep their tool calls and usage.
  const [history, setHistory] = useState<Entry[]>([])
  const [live, setLive] = useState<LiveMessage | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [streaming, setStreaming] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [showDetails, setShowDetails] = useState(readDetailsPref)
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setHistory([])
    setLive(undefined)
    setError(undefined)
    api
      .messages(agent.id)
      .then((messages) => {
        if (!cancelled) setHistory(messages.map(fromServer))
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
  }, [agent.id])

  useEffect(() => {
    const body = bodyRef.current
    if (body) body.scrollTop = body.scrollHeight
  }, [history, live])

  // Grow the composer with its content (up to the CSS max-height).
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${input.scrollHeight}px`
  }, [prompt])

  const send = useCallback(async () => {
    const text = prompt.trim()
    if (!text || streaming) return
    setPrompt('')
    setError(undefined)
    const now = Date.now()
    setHistory((prev) => [...prev, { id: `local-user-${now}`, role: 'user', content: text, tools: [], at: now }])
    // Local copy of the streaming message: state updaters must stay pure (StrictMode runs them twice).
    let current: LiveMessage = { role: 'assistant', content: '', tools: [], at: now }
    setLive(current)
    setStreaming(true)
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      for await (const event of api.turn(agent.id, text, controller.signal)) {
        if (event.type === 'error') {
          setError(event.message)
          continue
        }
        if (event.type === 'done') {
          if (event.stopReason === 'cancelled') {
            current = { ...current, cancelled: true }
            setLive(current)
          }
          continue
        }
        current = applyEvent(current, event)
        setLive(current)
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        current = { ...current, cancelled: true }
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
      // Keep the finished turn as it was streamed (tool calls, usage) instead of reloading text-only history.
      const finished: Entry = { ...current, id: `local-agent-${Date.now()}` }
      setLive(undefined)
      if (finished.content || finished.tools.length || finished.cancelled) setHistory((items) => [...items, finished])
      onChanged()
    }
  }, [agent.id, onChanged, prompt, streaming])

  const stop = useCallback(() => {
    controllerRef.current?.abort()
  }, [])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault()
        void send()
      }
    },
    [send],
  )

  const toggleDetails = useCallback(() => {
    setShowDetails((open) => {
      writeDetailsPref(!open)
      return !open
    })
  }, [])

  const subtitle = [agent.role, agent.driver.model ?? (agent.driver.name === 'driver-stub' ? 'test driver' : agent.driver.name)]
    .filter(Boolean)
    .join(' · ')
  const offline = agent.state !== 'active' && agent.state !== 'starting'

  const rows: React.ReactNode[] = []
  let previousAt: number | undefined
  const all = live ? [...history, { ...live, id: 'live' }] : history
  for (const entry of all) {
    if (needsDivider(previousAt, entry.at)) {
      rows.push(
        <div key={`t-${entry.id}`} className="time-divider">
          {dividerTime(entry.at)}
        </div>,
      )
    }
    previousAt = entry.at
    rows.push(<Bubble key={entry.id} entry={entry} live={entry.id === 'live'} />)
  }

  return (
    <div className={showDetails ? 'chat-layout with-details' : 'chat-layout'}>
      <div className="panel">
        <div className="panel-head chat-head">
          <div className="chat-title">
            <Avatar id={agent.id} name={agent.name} size={30} />
            <div className="title-block">
              <strong>{agent.name}</strong>
              <span>
                {offline ? <span className="state-off">{agent.state === 'failed' ? 'Failed' : 'Stopped'} · </span> : null}
                {subtitle}
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
            {all.length === 0 ? (
              <div className="chat-empty">
                <Avatar id={agent.id} name={agent.name} size={56} />
                <strong>{agent.name}</strong>
                <span className="muted">{agent.role ?? 'Say hello to get started.'}</span>
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
            placeholder={`Message ${agent.name}`}
            rows={1}
          />
          {streaming ? (
            <button className="send-btn send-stop" type="button" aria-label="Stop" title="Stop" onClick={stop}>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <rect width="12" height="12" rx="2" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button className="send-btn" type="button" aria-label="Send" title="Send" onClick={() => void send()} disabled={prompt.trim().length === 0}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M7 12V2M7 2 2.5 6.5M7 2l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {showDetails ? <AgentDetails agent={agent} onChanged={onChanged} onOpenMarket={onOpenMarket} onClose={toggleDetails} /> : null}
    </div>
  )
}
