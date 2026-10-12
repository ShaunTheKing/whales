import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api.ts'
import type { SearchKind, SearchStatus } from '../types.ts'

function errorText(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : String(err)
}

/**
 * "Web search" section of the Models page: pick a backend, paste its key (saved to the Keychain, never shown again)
 * and test it. Agents get search by switching on the Web search plugin.
 */
export function SearchSettings() {
  const mounted = useRef(true)
  const [status, setStatus] = useState<SearchStatus | undefined>(undefined)
  const [kind, setKind] = useState<SearchKind>('brave')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [binaryPath, setBinaryPath] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [result, setResult] = useState<{ ok: boolean; results: number; error?: string } | undefined>(undefined)

  const load = useCallback(async () => {
    try {
      const next = await api.searchStatus()
      if (!mounted.current) return
      setStatus(next)
      if (next.config) {
        setKind(next.config.kind)
        setBaseUrl(next.config.baseUrl ?? '')
        setBinaryPath(next.config.binaryPath ?? '')
      }
      setEditing(!next.config)
    } catch (err) {
      if (mounted.current) setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
    }
  }, [load])

  const backend = status?.backends.find((b) => b.kind === kind)

  const save = async () => {
    setBusy(true)
    setError(undefined)
    setResult(undefined)
    try {
      const input: { kind: SearchKind; baseUrl?: string; apiKey?: string; binaryPath?: string } = { kind }
      if (backend?.needsUrl) input.baseUrl = baseUrl.trim()
      if (backend?.local && binaryPath.trim()) input.binaryPath = binaryPath.trim()
      if (apiKey) input.apiKey = apiKey
      const next = await api.configureSearch(input)
      if (!mounted.current) return
      setApiKey('')
      setStatus(next)
      setEditing(false)
      const tested = await api.testSearch()
      if (mounted.current) setResult(tested)
    } catch (err) {
      if (!mounted.current) return
      setApiKey('')
      setError(errorText(err))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    setResult(undefined)
    try {
      const tested = await api.testSearch()
      if (mounted.current) setResult(tested)
    } catch (err) {
      if (mounted.current) setError(errorText(err))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const useFree = async () => {
    setBusy(true)
    setError(undefined)
    setResult(undefined)
    try {
      const next = await api.useManagedSearxng()
      if (!mounted.current) return
      setStatus(next)
      setEditing(false)
      const tested = await api.testSearch()
      if (mounted.current) setResult(tested)
    } catch (err) {
      if (mounted.current) setError(errorText(err))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const disable = async () => {
    if (!window.confirm('Turn off web search? Its saved key is deleted from the Keychain.')) return
    setBusy(true)
    try {
      await api.disableSearch()
      if (!mounted.current) return
      setResult(undefined)
      await load()
    } catch (err) {
      if (mounted.current) setError(errorText(err))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  if (!status) return error ? <div className="error">{error}</div> : null
  const config = status.config
  const current = config ? status.backends.find((b) => b.kind === config.kind) : undefined

  return (
    <section className="settings-section">
      <div className="settings-head">
        <div>
          <h2>Web search</h2>
          <p className="muted small">
            Lets agents search the live web and read pages. Switch on <strong>Web search</strong> in an agent's or room's plugins to use it.
          </p>
        </div>
        {config && !editing ? (
          <div className="row">
            <button type="button" className="btn btn-sm" onClick={() => void test()} disabled={busy}>
              {busy ? 'Testing…' : 'Test'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
              Change
            </button>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => void disable()} disabled={busy}>
              Turn off
            </button>
          </div>
        ) : null}
      </div>

      {status.managed && (!config || config.managed) ? (
        <div className="free-card">
          <div className="grow">
            <div className="row">
              <strong>Free web search</strong>
              {status.managed.state === 'running' ? (
                <span className="badge badge-ok">Running</span>
              ) : status.managed.state === 'starting' || busy ? (
                <span className="badge">Starting…</span>
              ) : status.managed.state === 'no-docker' ? (
                <span className="badge badge-warn">Needs Docker</span>
              ) : status.managed.state === 'error' ? (
                <span className="badge badge-danger">Problem</span>
              ) : (
                <span className="badge">Ready</span>
              )}
            </div>
            <div className="muted small">
              {status.managed.state === 'running'
                ? 'SearXNG runs privately on this Mac in Docker. No key, no account, no cost. Whales stops it when you quit.'
                : status.managed.state === 'no-docker'
                  ? 'Whales can run SearXNG for you in Docker. Install Docker Desktop (docker.com) or OrbStack first.'
                  : 'Whales runs SearXNG privately on this Mac in Docker, with no key, account or cost. It turns on by itself the first time an agent searches, or start it now. The first start downloads it (about 100 MB).'}
            </div>
            {status.managed.url && status.managed.state === 'running' ? <div className="mono small">{status.managed.url}</div> : null}
            {status.managed.detail && status.managed.state === 'error' ? <div className="error">{status.managed.detail}</div> : null}
          </div>
          {status.managed.state !== 'running' && status.managed.state !== 'no-docker' ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void useFree()} disabled={busy || status.managed.state === 'starting'}>
              {busy ? 'Starting…' : 'Start now'}
            </button>
          ) : null}
        </div>
      ) : null}

      {config && !editing ? (
        <div className="list">
          <div className="list-row">
            <div className="grow">
              <div>
                <strong>{config.managed ? 'SearXNG (run by Whales)' : (current?.label ?? config.kind)}</strong>{' '}
                {config.key === 'keychain' ? (
                  <span className="badge badge-ok">Key in Keychain</span>
                ) : config.key === 'env' ? (
                  <span className="badge">Key from {current?.keyEnv}</span>
                ) : current?.needsKey ? (
                  <span className="badge badge-warn">No key</span>
                ) : (
                  <span className="badge">No key needed</span>
                )}
              </div>
              {config.baseUrl ? <div className="mono">{config.baseUrl}</div> : null}
              {config.program ? (
                config.program.path ? (
                  <div className="muted small">
                    Runs <span className="mono">{config.program.path}</span>
                  </div>
                ) : (
                  <div className="error">{config.program.error}</div>
                )
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <div className="stack">
          <div className="segmented" role="radiogroup" aria-label="Search backend">
            {status.backends.map((b) => (
              <button
                key={b.kind}
                type="button"
                role="radio"
                aria-checked={kind === b.kind}
                className={kind === b.kind ? 'segment segment-on' : 'segment'}
                onClick={() => setKind(b.kind)}
              >
                {b.label}
              </button>
            ))}
          </div>
          {backend?.needsUrl ? (
            <label className="field">
              <span>Your SearXNG address (JSON output must be enabled)</span>
              <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:8888" />
            </label>
          ) : null}
          {backend?.local ? (
            <>
              <div className="warning">
                DonSeTch runs on your Mac and searches without keys by scraping several search engines (Google, Bing and
                others), which their terms of service do not allow; they may rate-limit or block you. Whales only uses its
                search; pages are still opened by Whales' own protected reader. Install it yourself first:
                <div className="mono" style={{ marginTop: 6 }}>brew tap dondai44423/donsetch &amp;&amp; brew install donsetch</div>
              </div>
              <label className="field">
                <span>Program path (optional; leave empty to find it automatically)</span>
                <input className="input" value={binaryPath} onChange={(e) => setBinaryPath(e.target.value)} placeholder="/opt/homebrew/bin/donsetch" />
              </label>
            </>
          ) : null}
          {backend?.needsKey ? (
            <label className="field">
              <span>API key</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={config?.kind === kind && config.key === 'keychain' ? 'Saved. Paste a new key to replace it' : 'Paste your key'}
              />
              <span className="muted small">
                Saved to your Mac's Keychain. Get one at <span className="mono">{backend.docs}</span>
              </span>
            </label>
          ) : null}
          {status.secretStore === 'none' && backend?.needsKey ? (
            <div className="warning">No Keychain on this system: set {backend.keyEnv} in the environment instead.</div>
          ) : null}
          <div className="row">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save and test'}
            </button>
            {config ? (
              <button type="button" className="btn btn-sm" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      )}

      {result && !(result.error && result.error === config?.program?.error) ? (
        result.ok ? (
          <div className="note-ok">Search works · {result.results} results for a test query</div>
        ) : (
          <div className="error">{result.error ?? 'Search failed'}</div>
        )
      ) : null}
      {error ? <div className="error">{error}</div> : null}
    </section>
  )
}
