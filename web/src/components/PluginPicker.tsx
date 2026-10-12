import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '../api.ts'
import type { CatalogEntry, PluginRef, RoomPluginStatus } from '../types.ts'

type Target = { kind: 'agent'; id: string; name: string } | { kind: 'room'; id: string; name: string }

interface Draft {
  enabled: boolean
  configText: string
}

interface Entry {
  name: string
  kind: 'builtin' | 'market'
  description?: string
  version?: string
  missing: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function configToText(config: Record<string, unknown> | undefined): string {
  if (config === undefined) return ''
  return JSON.stringify(config, null, 2)
}

function parseConfig(text: string): { ok: true; value: Record<string, unknown> | undefined } | { ok: false } {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, value: undefined }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!isPlainObject(parsed)) return { ok: false }
    return { ok: true, value: parsed }
  } catch {
    return { ok: false }
  }
}

export function PluginPicker(props: {
  target: Target
  onClose(): void
  onChanged(): void
  onOpenMarket(): void
}) {
  const { target, onClose, onChanged, onOpenMarket } = props

  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [current, setCurrent] = useState<PluginRef[]>([])
  const [draft, setDraft] = useState<Map<string, Draft>>(new Map())
  const [status, setStatus] = useState<RoomPluginStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(undefined)
    setSaved(false)

    const load = async () => {
      const entries = await api.catalog()
      let refs: PluginRef[] = []
      let roomStatus: RoomPluginStatus[] = []
      if (target.kind === 'agent') {
        const data = await api.agentPlugins(target.id)
        refs = data.plugins
      } else {
        const data = await api.roomPlugins(target.id)
        refs = data.plugins
        roomStatus = data.status
      }
      if (cancelled || !mounted.current) return
      const next = new Map<string, Draft>()
      for (const ref of refs) {
        next.set(ref.name, { enabled: true, configText: configToText(ref.config) })
      }
      setCatalog(entries)
      setCurrent(refs)
      setDraft(next)
      setStatus(roomStatus)
      setLoading(false)
    }

    load().catch((err: unknown) => {
      if (cancelled || !mounted.current) return
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to load plugins')
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [target.kind, target.id])

  const eligible = useMemo(() => {
    const list: CatalogEntry[] = []
    for (const entry of catalog) {
      if (!entry.scopes.includes(target.kind)) continue
      if (target.kind === 'agent' && entry.name.startsWith('driver-')) continue
      list.push(entry)
    }
    return list
  }, [catalog, target.kind])

  const entries = useMemo(() => {
    const byName = new Map<string, CatalogEntry>()
    for (const entry of eligible) byName.set(entry.name, entry)

    const result: Entry[] = []
    const seen = new Set<string>()

    // Current list first (preserves order and surfaces missing plugins).
    for (const ref of current) {
      if (seen.has(ref.name)) continue
      seen.add(ref.name)
      const entry = byName.get(ref.name)
      if (entry) {
        result.push({
          name: entry.name,
          kind: entry.kind,
          missing: false,
          ...(entry.description !== undefined ? { description: entry.description } : {}),
          ...(entry.version !== undefined ? { version: entry.version } : {}),
        })
      } else {
        result.push({ name: ref.name, kind: 'market', missing: true })
      }
    }

    // Then the rest of the eligible catalog.
    for (const entry of eligible) {
      if (seen.has(entry.name)) continue
      seen.add(entry.name)
      result.push({
        name: entry.name,
        kind: entry.kind,
        missing: false,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        ...(entry.version !== undefined ? { version: entry.version } : {}),
      })
    }

    return result
  }, [current, eligible])

  const marketEntries = useMemo(() => entries.filter((entry) => entry.kind === 'market'), [entries])
  const builtinEntries = useMemo(() => entries.filter((entry) => entry.kind === 'builtin'), [entries])

  const getDraft = useCallback(
    (name: string): Draft => draft.get(name) ?? { enabled: false, configText: '' },
    [draft],
  )

  const setEntry = useCallback((name: string, next: Draft) => {
    setDraft((prev) => {
      const copy = new Map(prev)
      copy.set(name, next)
      return copy
    })
    setSaved(false)
  }, [])

  const invalidNames = useMemo(() => {
    const bad = new Set<string>()
    for (const entry of entries) {
      const d = draft.get(entry.name)
      if (!d || !d.enabled) continue
      if (!parseConfig(d.configText).ok) bad.add(entry.name)
    }
    return bad
  }, [entries, draft])

  const changed = useMemo(() => {
    const currentNames = new Set(current.map((ref) => ref.name))
    for (const entry of entries) {
      const d = draft.get(entry.name)
      const enabled = d?.enabled ?? false
      const wasEnabled = currentNames.has(entry.name)
      if (enabled !== wasEnabled) return true
      if (enabled) {
        const ref = current.find((r) => r.name === entry.name)
        const before = configToText(ref?.config)
        const after = (d?.configText ?? '').trim()
        if (before.trim() !== after) return true
      }
    }
    return false
  }, [current, draft, entries])

  const buildRefs = useCallback((): PluginRef[] => {
    const refs: PluginRef[] = []
    const seen = new Set<string>()

    const push = (name: string) => {
      if (seen.has(name)) return
      const d = draft.get(name)
      if (!d || !d.enabled) return
      seen.add(name)
      const parsed = parseConfig(d.configText)
      if (parsed.ok && parsed.value !== undefined) {
        refs.push({ name, config: parsed.value })
      } else {
        refs.push({ name })
      }
    }

    for (const ref of current) push(ref.name)
    for (const entry of eligible) push(entry.name)

    return refs
  }, [current, draft, eligible])

  const save = useCallback(async () => {
    if (saving || !changed || invalidNames.size > 0) return
    setSaving(true)
    setError(undefined)
    setSaved(false)
    const refs = buildRefs()
    try {
      if (target.kind === 'agent') {
        await api.setAgentPlugins(target.id, refs)
        if (!mounted.current) return
        setSaving(false)
        onChanged()
        onClose()
      } else {
        const result = await api.setRoomPlugins(target.id, refs)
        if (!mounted.current) return
        setCurrent(refs)
        setStatus(result.status)
        setSaving(false)
        setSaved(true)
        onChanged()
      }
    } catch (err: unknown) {
      if (!mounted.current) return
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to save plugins'
      if (target.kind === 'agent' && err instanceof ApiError && err.status === 400) {
        setError(`${message} — the previous plugins were kept.`)
      } else {
        setError(message)
      }
      setSaving(false)
    }
  }, [buildRefs, changed, invalidNames, onChanged, onClose, saving, target.id, target.kind])

  const intro =
    target.kind === 'agent'
      ? "Switch plugins on for this chat's agent. Saving restarts the agent if it is running."
      : 'Room plugins are available to every member, only inside this room. Tool calls in rooms always ask for approval.'

  const renderEntry = (entry: Entry) => {
    const d = getDraft(entry.name)
    const invalid = d.enabled && invalidNames.has(entry.name)
    const entryStatus = status.filter((s) => s.plugin === entry.name)
    const failed = entryStatus.filter((s) => s.state === 'failed')
    const activeCount = entryStatus.filter((s) => s.state === 'active').length

    return (
      <label className="plugin-row" key={entry.name}>
        <input
          type="checkbox"
          className="switch"
          checked={d.enabled}
          onChange={(event) => setEntry(entry.name, { enabled: event.target.checked, configText: d.configText })}
        />
        <div className="grow">
          <div>
            <strong>{entry.name}</strong>{' '}
            {entry.version !== undefined && entry.version !== '' && <span className="muted">v{entry.version}</span>}{' '}
            {entry.missing && <span className="badge badge-danger">Missing</span>}
          </div>
          {entry.description !== undefined && <div className="muted">{entry.description}</div>}
          {d.enabled && (
            <details>
              <summary className="muted">Settings (JSON)</summary>
              <textarea
                className="input mono"
                rows={4}
                placeholder="{ }"
                value={d.configText}
                onChange={(event) => setEntry(entry.name, { enabled: d.enabled, configText: event.target.value })}
              />
              {invalid && <div className="error">Invalid JSON: expected a plain object.</div>}
            </details>
          )}
          {target.kind === 'room' && d.enabled && (
            <div>
              {failed.map((s) => (
                <div className="error" key={s.agentId}>
                  {s.agentId}: {s.error ?? 'failed'}
                </div>
              ))}
              {failed.length === 0 && activeCount > 0 && (
                <span className="badge badge-ok">Active in {activeCount} members</span>
              )}
            </div>
          )}
        </div>
      </label>
    )
  }

  return (
    <div className="drawer" role="dialog" aria-label={`Plugins for ${target.name}`}>
      <div className="drawer-head">
        <span>Plugins · {target.name}</span>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="drawer-body">
        {error !== undefined && <div className="error">{error}</div>}
        {saved && <span className="badge badge-ok">Saved</span>}
        <div className="muted">{intro}</div>
        {loading ? (
          <div className="empty">Loading…</div>
        ) : (
          <>
            <div className="nav-label">Installed from marketplace</div>
            {marketEntries.length === 0 ? (
              <div className="empty">No marketplace plugins installed yet.</div>
            ) : (
              marketEntries.map(renderEntry)
            )}
            {builtinEntries.length > 0 && (
              <>
                <div className="nav-label">Built-in</div>
                {builtinEntries.map(renderEntry)}
              </>
            )}
          </>
        )}
        <button className="btn btn-ghost btn-sm" onClick={onOpenMarket}>
          Browse marketplace
        </button>
      </div>
      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={!changed || saving || invalidNames.size > 0}
          onClick={() => {
            void save()
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
