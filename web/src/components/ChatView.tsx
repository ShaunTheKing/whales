import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { api, ApiError } from '../api.ts'
import type { AgentView, DmMessage, DriverEvent } from '../types.ts'
import { ToolCallView } from './ToolCallView.tsx'
import { PluginPicker } from './PluginPicker.tsx'
import { HistoryPanel } from './HistoryPanel.tsx'

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
  usage?: { inputTokens: number; outputTokens: number }
  cancelled?: boolean
}

type Entry = LiveMessage & { id: string }

function fromServer(message: DmMessage): Entry {
  return { id: message.id, role: message.role, content: message.content, tools: [] }
}

function renderEntry(entry: Entry, agentName: string) {
  return (
    <div key={entry.id} className={entry.role === 'user' ? 'msg msg-user' : 'msg msg-agent'}>
      <div className="msg-head">
        {entry.role === 'user' ? 'You' : agentName}
        {entry.cancelled ? <span className="badge">cancelled</span> : null}
      </div>
      {entry.content ? <div className="msg-body">{entry.content}</div> : null}
      {entry.tools.map((tool) => (
        <ToolCallView key={tool.id} name={tool.name} input={tool.input} result={tool.result} />
      ))}
      {entry.usage ? (
        <div className="muted">
          · {entry.usage.inputTokens} in / {entry.usage.outputTokens} out
        </div>
      ) : null}
    </div>
  )
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

export function ChatView(props: { agent: AgentView; onChanged(): void; onOpenMarket(): void }) {
  const { agent, onChanged, onOpenMarket } = props
  const [showPlugins, setShowPlugins] = useState(false)
  // Server history (text only) plus turns finished in this session, which keep their tool calls and usage.
  const [history, setHistory] = useState<Entry[]>([])
  const [live, setLive] = useState<LiveMessage | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [streaming, setStreaming] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const bodyRef = useRef<HTMLDivElement | null>(null)

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

  const send = useCallback(async () => {
    const text = prompt.trim()
    if (!text || streaming) return
    setPrompt('')
    setError(undefined)
    setHistory((prev) => [...prev, { id: `local-user-${Date.now()}`, role: 'user', content: text, tools: [] }])
    // Local copy of the streaming message: state updaters must stay pure (StrictMode runs them twice).
    let current: LiveMessage = { role: 'assistant', content: '', tools: [] }
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
      setHistory((items) => [...items, finished])
      onChanged()
    }
  }, [agent.id, onChanged, prompt, streaming])

  const stop = useCallback(() => {
    controllerRef.current?.abort()
  }, [])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void send()
      }
    },
    [send],
  )

  const toggleState = useCallback(async () => {
    setError(undefined)
    try {
      if (agent.state === 'active' || agent.state === 'starting') await api.stopAgent(agent.id)
      else await api.startAgent(agent.id)
      onChanged()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [agent.id, agent.state, onChanged])

  const remove = useCallback(async () => {
    if (!window.confirm(`Delete agent "${agent.name}"?`)) return
    setError(undefined)
    try {
      await api.deleteAgent(agent.id)
      onChanged()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [agent.id, agent.name, onChanged])

  const running = agent.state === 'active' || agent.state === 'starting'

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="title-block">
          <strong>{agent.name}</strong>
          <span>
            {agent.role ? `${agent.role} · ` : ''}
            {agent.driver.model ?? agent.driver.name} · {agent.state}
            {agent.plugins.length ? ` · ${agent.plugins.join(', ')}` : ''}
          </span>
        </div>
        <div className="header-actions">
          <button className="btn btn-sm" type="button" onClick={() => setShowPlugins(true)}>
            Plugins
          </button>
          <button className="btn btn-sm" type="button" onClick={() => setShowHistory((value) => !value)}>
            History
          </button>
          <button className="btn btn-sm" type="button" onClick={() => void toggleState()}>
            {running ? 'Stop' : 'Start'}
          </button>
          <button className="btn btn-danger btn-sm" type="button" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      </div>
      {showPlugins ? (
        <PluginPicker
          target={{ kind: 'agent', id: agent.id, name: agent.name }}
          onClose={() => setShowPlugins(false)}
          onChanged={onChanged}
          onOpenMarket={onOpenMarket}
        />
      ) : null}
      {showHistory ? <HistoryPanel agentId={agent.id} /> : null}
      <div className="panel-body" ref={bodyRef}>
        <div className="messages">
          {history.map((entry) => renderEntry(entry, agent.name))}
          {live ? renderEntry({ ...live, id: 'live' }, agent.name) : null}
          {error ? <div className="msg msg-system error">{error}</div> : null}
        </div>
      </div>
      <div className="composer">
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Message ${agent.name}…`}
          rows={1}
        />
        {streaming ? (
          <button className="btn btn-sm" type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="send-btn" type="button" aria-label="Send" title="Send" onClick={() => void send()} disabled={prompt.trim().length === 0}>
            ↑
          </button>
        )}
      </div>
    </div>
  )
}
