import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { api, ApiError } from '../api.ts'
import type { AgentView, DmMessage, DriverEvent } from '../types.ts'
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
  usage?: { inputTokens: number; outputTokens: number }
  cancelled?: boolean
}

function applyEvent(message: LiveMessage, event: DriverEvent): LiveMessage {
  switch (event.type) {
    case 'text':
      return { ...message, content: message.content + event.delta }
    case 'tool_call':
      return { ...message, tools: [...message.tools, { id: event.id, name: event.name, input: event.input }] }
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

export function ChatView(props: { agent: AgentView; onChanged(): void }) {
  const { agent, onChanged } = props
  const [history, setHistory] = useState<DmMessage[]>([])
  const [live, setLive] = useState<LiveMessage | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [streaming, setStreaming] = useState(false)
  const [prompt, setPrompt] = useState('')
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
    setHistory((prev) => [...prev, { id: `local-${Date.now()}`, role: 'user', content: text, createdAt: Date.now(), turnId: '' }])
    setLive({ role: 'assistant', content: '', tools: [] })
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
          if (event.stopReason === 'cancelled') setLive((prev) => (prev ? { ...prev, cancelled: true } : prev))
          continue
        }
        setLive((prev) => (prev ? applyEvent(prev, event) : prev))
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setLive((prev) => (prev ? { ...prev, cancelled: true } : prev))
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
      setLive(undefined)
      onChanged()
      api
        .messages(agent.id)
        .then(setHistory)
        .catch(() => undefined)
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
        <div>
          <strong>{agent.name}</strong>
          <span className="muted">
            {' '}
            {agent.role ? `${agent.role} · ` : ''}
            {agent.driver.name}
            {agent.driver.model ? `/${agent.driver.model}` : ''} · {agent.state}
          </span>
        </div>
        <div className="row">
          <button className="btn" type="button" onClick={() => void toggleState()}>
            {running ? 'Stop' : 'Start'}
          </button>
          <button className="btn-danger" type="button" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      </div>
      <div className="panel-body" ref={bodyRef}>
        <div className="messages">
          {history.map((message) => (
            <div key={message.id} className={message.role === 'user' ? 'msg msg-user' : 'msg msg-agent'}>
              <div className="msg-head">{message.role === 'user' ? 'You' : agent.name}</div>
              <div className="msg-body">{message.content}</div>
            </div>
          ))}
          {live ? (
            <div className={live.role === 'user' ? 'msg msg-user' : 'msg msg-agent'}>
              <div className="msg-head">
                {live.role === 'user' ? 'You' : agent.name}
                {live.cancelled ? <span className="badge">cancelled</span> : null}
              </div>
              <div className="msg-body">{live.content}</div>
              {live.tools.map((tool) => (
                <ToolCallView key={tool.id} name={tool.name} input={tool.input} result={tool.result} />
              ))}
              {live.usage ? (
                <div className="muted">
                  · {live.usage.inputTokens} in / {live.usage.outputTokens} out
                </div>
              ) : null}
            </div>
          ) : null}
          {error ? <div className="msg msg-system error">{error}</div> : null}
        </div>
      </div>
      <div className="composer">
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message the agent…"
          rows={2}
        />
        {streaming ? (
          <button className="btn" type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="btn-primary" type="button" onClick={() => void send()} disabled={prompt.trim().length === 0}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}
