import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api.ts'
import type { Checkpoint, FileChange } from '../types.ts'

const MAX_PATCH = 20000

function truncate(text: string): string {
  if (text.length <= MAX_PATCH) return text
  return `${text.slice(0, MAX_PATCH)}\n… (truncated)`
}

function localTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

function statusClass(status: FileChange['status']): string {
  if (status === 'added') return 'badge'
  if (status === 'deleted') return 'badge error'
  return 'badge'
}

export function HistoryPanel(props: { agentId: string }) {
  const { agentId } = props
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [diffFor, setDiffFor] = useState<string | undefined>(undefined)
  const [diff, setDiff] = useState<{ changes: FileChange[]; patch: string } | undefined>(undefined)

  const load = useCallback(async () => {
    setError(undefined)
    try {
      const list = await api.checkpoints(agentId)
      setCheckpoints([...list].sort((a, b) => b.createdAt - a.createdAt))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [agentId])

  useEffect(() => {
    setCheckpoints([])
    setDiff(undefined)
    setDiffFor(undefined)
    setNotice(undefined)
    void load()
  }, [load])

  const snapshot = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      await api.snapshot(agentId, 'manual snapshot')
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [agentId, load])

  const showDiff = useCallback(
    async (id: string) => {
      if (diffFor === id) {
        setDiffFor(undefined)
        setDiff(undefined)
        return
      }
      setError(undefined)
      setNotice(undefined)
      try {
        const result = await api.diff(id)
        setDiffFor(id)
        setDiff(result)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [diffFor],
  )

  const restore = useCallback(
    async (id: string) => {
      if (!window.confirm('Restore the workspace to this checkpoint? A safety snapshot is taken first.')) return
      setBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        await api.restore(id)
        setNotice('Restored. Undo by restoring the safety snapshot.')
        await load()
      } catch (err: unknown) {
        if (err instanceof ApiError) setError(err.message)
        else setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  return (
    <div className="panel">
      <div className="panel-head">
        <strong>History</strong>
        <div className="row">
          <button className="btn" type="button" onClick={() => void snapshot()} disabled={busy}>
            Snapshot now
          </button>
        </div>
      </div>
      <div className="panel-body">
        {error ? <div className="error">{error}</div> : null}
        {notice ? <div className="muted">{notice}</div> : null}
        {checkpoints.length === 0 ? (
          <div className="empty">No checkpoints yet.</div>
        ) : (
          <div className="messages">
            {checkpoints.map((checkpoint) => (
              <div key={checkpoint.id} className="msg">
                <div className="msg-head">
                  <span className="badge">{checkpoint.phase}</span>
                  <span>{checkpoint.label}</span>
                  <span className="muted">{localTime(checkpoint.createdAt)}</span>
                </div>
                <div className="row">
                  <button className="btn-ghost" type="button" onClick={() => void showDiff(checkpoint.id)}>
                    Changes
                  </button>
                  <button className="btn" type="button" onClick={() => void restore(checkpoint.id)} disabled={busy}>
                    Restore
                  </button>
                </div>
                {diffFor === checkpoint.id && diff ? (
                  <div>
                    {diff.changes.length === 0 ? (
                      <div className="muted">No changes.</div>
                    ) : (
                      <div className="row">
                        {diff.changes.map((change) => (
                          <span key={change.path} className={statusClass(change.status)}>
                            {change.path} · {change.status}
                          </span>
                        ))}
                      </div>
                    )}
                    <pre className="tool-io">{truncate(diff.patch)}</pre>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
