import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.ts'
import type { AgentView } from '../types.ts'
import { Avatar } from './Avatar.tsx'
import { HistoryPanel } from './HistoryPanel.tsx'
import { PluginPicker } from './PluginPicker.tsx'

const PLUGIN_LABELS: Record<string, string> = {
  memory: 'Memory',
  workspace: 'Files',
  skills: 'Skills',
  checkpoints: 'Undo snapshots',
  'bridge-telegram': 'Telegram',
  'web-search': 'Web search',
}

/** Right-hand panel of a chat: who the agent is, which model and plugins it uses, and its lifecycle controls. */
export function AgentDetails(props: { agent: AgentView; onChanged(): void; onOpenMarket(): void; onClose(): void }) {
  const { agent, onChanged, onOpenMarket, onClose } = props
  const [showPlugins, setShowPlugins] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    setError(undefined)
    setShowHistory(false)
  }, [agent.id])

  useEffect(() => {
    if (!showHistory) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowHistory(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showHistory])

  const running = agent.state === 'active' || agent.state === 'starting'

  const toggleState = useCallback(async () => {
    setError(undefined)
    setBusy(true)
    try {
      if (running) await api.stopAgent(agent.id)
      else await api.startAgent(agent.id)
      onChanged()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [agent.id, onChanged, running])

  const remove = useCallback(async () => {
    if (!window.confirm(`Delete ${agent.name}? Its chat history is removed too.`)) return
    setError(undefined)
    try {
      await api.deleteAgent(agent.id)
      onChanged()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [agent.id, agent.name, onChanged])

  const model = agent.driver.name === 'driver-stub' ? 'Test driver (no model)' : (agent.driver.model ?? 'Provider default')

  return (
    <aside className="details" aria-label={`${agent.name} details`}>
      <div className="details-head">
        <span>Details</span>
        <button type="button" className="icon-btn" onClick={onClose} title="Close details" aria-label="Close details">
          ×
        </button>
      </div>
      <div className="details-body">
        <div className="details-hero">
          <Avatar id={agent.id} name={agent.name} size={56} />
          <strong>{agent.name}</strong>
          {agent.role ? <span className="muted">{agent.role}</span> : null}
        </div>

        <section className="details-section">
          <div className="details-label">Model</div>
          <div className="details-value">{model}</div>
          {agent.driver.provider ? <div className="muted small">via {agent.driver.provider}</div> : null}
        </section>

        <section className="details-section">
          <div className="details-label">
            <span>Plugins</span>
            <button type="button" className="link-btn" onClick={() => setShowPlugins(true)}>
              Manage
            </button>
          </div>
          {agent.plugins.length ? (
            <div className="chips">
              {agent.plugins.map((name) => (
                <span key={name} className="chip">
                  {PLUGIN_LABELS[name] ?? name}
                </span>
              ))}
            </div>
          ) : (
            <div className="muted small">None yet</div>
          )}
        </section>

        <section className="details-section">
          <div className="details-label">Status</div>
          <div className="details-row">
            <span className="row">
              <span className={running ? 'dot dot-active' : agent.state === 'failed' ? 'dot dot-failed' : 'dot dot-stopped'} />
              {running ? 'Running' : agent.state === 'failed' ? 'Failed' : 'Stopped'}
            </span>
            <button type="button" className="btn btn-sm" onClick={() => void toggleState()} disabled={busy}>
              {running ? 'Stop' : 'Start'}
            </button>
          </div>
        </section>

        <section className="details-section">
          <div className="details-label">Workspace</div>
          <button type="button" className="details-link" onClick={() => setShowHistory(true)}>
            <span>Undo history</span>
            <span className="muted">›</span>
          </button>
        </section>

        {error ? <div className="error">{error}</div> : null}

        <div className="details-foot">
          <button type="button" className="btn btn-danger btn-sm" onClick={() => void remove()}>
            Delete agent
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

      {showHistory ? (
        <div className="modal-backdrop" onClick={() => setShowHistory(false)}>
          <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">
              <h2>Undo history · {agent.name}</h2>
              <button type="button" className="icon-btn" onClick={() => setShowHistory(false)} aria-label="Close">
                ×
              </button>
            </div>
            <HistoryPanel agentId={agent.id} />
          </div>
        </div>
      ) : null}
    </aside>
  )
}
