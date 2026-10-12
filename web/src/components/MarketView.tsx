import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api.ts'
import type { BrowseResult, IndexEntry, InstallPreview, InstalledPlugin, MarketSource } from '../types.ts'

type Tab = 'discover' | 'installed' | 'sources'

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

function scopeLabel(scope: 'agent' | 'room'): string {
  return scope === 'agent' ? 'chat' : 'room'
}

const INDEX_EXAMPLE = JSON.stringify(
  {
    version: 1,
    name: 'My plugins',
    plugins: [
      {
        name: 'dice',
        version: '1.0.0',
        description: 'Roll dice',
        repo: 'https://github.com/owner/repo',
        commit: '<40-hex commit>',
        path: 'plugins/dice',
        scopes: ['agent', 'room'],
      },
    ],
  },
  null,
  2,
)

export function MarketView(props: { onChanged(): void }) {
  const [tab, setTab] = useState<Tab>('discover')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // ---- shared state ----
  const [installed, setInstalled] = useState<InstalledPlugin[]>([])
  const [installedLoaded, setInstalledLoaded] = useState(false)
  const [installedError, setInstalledError] = useState<string | undefined>(undefined)

  const [sources, setSources] = useState<MarketSource[]>([])
  const [sourcesLoaded, setSourcesLoaded] = useState(false)
  const [sourcesError, setSourcesError] = useState<string | undefined>(undefined)

  const [browse, setBrowse] = useState<BrowseResult[]>([])
  const [browsing, setBrowsing] = useState(false)
  const [browseError, setBrowseError] = useState<string | undefined>(undefined)
  const [browsed, setBrowsed] = useState(false)

  const [search, setSearch] = useState('')

  const [busyKey, setBusyKey] = useState<string | undefined>(undefined)
  const [cardError, setCardError] = useState<{ key: string; message: string } | undefined>(undefined)

  const [preview, setPreview] = useState<InstallPreview | undefined>(undefined)
  const [ack, setAck] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [previewError, setPreviewError] = useState<string | undefined>(undefined)
  const [confirmation, setConfirmation] = useState<string | undefined>(undefined)

  const [newSourceUrl, setNewSourceUrl] = useState('')
  const [addingSource, setAddingSource] = useState(false)
  const [sourceFormError, setSourceFormError] = useState<string | undefined>(undefined)

  const [repoUrl, setRepoUrl] = useState('')
  const [repoCommit, setRepoCommit] = useState('')
  const [repoPath, setRepoPath] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [formError, setFormError] = useState<string | undefined>(undefined)

  const loadInstalled = useCallback(async () => {
    try {
      const list = await api.installed()
      if (!mounted.current) return
      setInstalled(list)
      setInstalledError(undefined)
    } catch (err) {
      if (!mounted.current) return
      setInstalledError(errorText(err))
    } finally {
      if (mounted.current) setInstalledLoaded(true)
    }
  }, [])

  const loadSources = useCallback(async () => {
    try {
      const list = await api.marketSources()
      if (!mounted.current) return
      setSources(list)
      setSourcesError(undefined)
    } catch (err) {
      if (!mounted.current) return
      setSourcesError(errorText(err))
    } finally {
      if (mounted.current) setSourcesLoaded(true)
    }
  }, [])

  const runBrowse = useCallback(async () => {
    setBrowsing(true)
    setBrowseError(undefined)
    try {
      const results = await api.browse()
      if (!mounted.current) return
      setBrowse(results)
    } catch (err) {
      if (!mounted.current) return
      setBrowseError(errorText(err))
    } finally {
      if (mounted.current) {
        setBrowsing(false)
        setBrowsed(true)
      }
    }
  }, [])

  useEffect(() => {
    void loadInstalled()
    void loadSources()
  }, [loadInstalled, loadSources])

  useEffect(() => {
    if (tab === 'discover' && !browsed && !browsing) void runBrowse()
  }, [tab, browsed, browsing, runBrowse])

  useEffect(() => {
    if (tab === 'installed') void loadInstalled()
  }, [tab, loadInstalled])

  useEffect(() => {
    if (tab === 'sources') void loadSources()
  }, [tab, loadSources])

  // ---- preview modal ----
  const closePreview = useCallback(() => {
    setPreview(undefined)
    setAck(false)
    setPreviewError(undefined)
    setInstalling(false)
  }, [])

  useEffect(() => {
    if (!preview) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePreview()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview, closePreview])

  const openPreview = useCallback(async (key: string, input: Parameters<typeof api.preview>[0]) => {
    setBusyKey(key)
    setCardError(undefined)
    setFormError(undefined)
    try {
      const result = await api.preview(input)
      if (!mounted.current) return
      setPreview(result)
      setAck(false)
      setPreviewError(undefined)
    } catch (err) {
      if (!mounted.current) return
      const message = errorText(err)
      if (key.startsWith('form:')) setFormError(message)
      else setCardError({ key, message })
    } finally {
      if (mounted.current) setBusyKey(undefined)
    }
  }, [])

  const confirmInstall = useCallback(async () => {
    if (!preview || !ack) return
    setInstalling(true)
    setPreviewError(undefined)
    try {
      const plugin = await api.install(preview)
      if (!mounted.current) return
      closePreview()
      setConfirmation(`Installed ${plugin.name}. Switch it on from a chat or room's Plugins button.`)
      await loadInstalled()
      props.onChanged()
    } catch (err) {
      if (!mounted.current) return
      setPreviewError(errorText(err))
      setInstalling(false)
    }
  }, [preview, ack, closePreview, loadInstalled, props])

  // ---- uninstall ----
  const uninstall = useCallback(
    async (name: string) => {
      if (!window.confirm(`Uninstall ${name}?`)) return
      try {
        await api.uninstall(name)
        if (!mounted.current) return
        await loadInstalled()
        props.onChanged()
      } catch (err) {
        if (!mounted.current) return
        setInstalledError(errorText(err))
      }
    },
    [loadInstalled, props],
  )

  // ---- sources ----
  const addSource = useCallback(async () => {
    const url = newSourceUrl.trim()
    if (!url) return
    setAddingSource(true)
    setSourceFormError(undefined)
    try {
      await api.addMarketSource(url)
      if (!mounted.current) return
      setNewSourceUrl('')
      await loadSources()
      setBrowsed(false)
    } catch (err) {
      if (!mounted.current) return
      setSourceFormError(errorText(err))
    } finally {
      if (mounted.current) setAddingSource(false)
    }
  }, [newSourceUrl, loadSources])

  const removeSource = useCallback(
    async (source: MarketSource) => {
      if (!window.confirm(`Remove source ${source.url}?`)) return
      try {
        await api.removeMarketSource(source.id)
        if (!mounted.current) return
        await loadSources()
        setBrowsed(false)
      } catch (err) {
        if (!mounted.current) return
        setSourcesError(errorText(err))
      }
    },
    [loadSources],
  )

  // ---- github / local forms ----
  const commitValid = /^[0-9a-f]{40}$/.test(repoCommit.trim())

  const submitRepo = useCallback(() => {
    const repo = repoUrl.trim()
    const commit = repoCommit.trim()
    const path = repoPath.trim()
    if (!repo || !/^[0-9a-f]{40}$/.test(commit)) {
      setFormError('Enter a repository URL and a full 40-character commit hash.')
      return
    }
    const input = path ? { repo, commit, path } : { repo, commit }
    void openPreview('form:repo', input)
  }, [repoUrl, repoCommit, repoPath, openPreview])

  const submitLocal = useCallback(() => {
    const local = localPath.trim()
    if (!local) {
      setFormError('Enter an absolute folder path.')
      return
    }
    void openPreview('form:local', { local })
  }, [localPath, openPreview])

  // ---- derived ----
  const installedByName = new Map<string, InstalledPlugin>()
  for (const plugin of installed) installedByName.set(plugin.name, plugin)

  const query = search.trim().toLowerCase()
  const matches = (entry: IndexEntry): boolean => {
    if (!query) return true
    if (entry.name.toLowerCase().includes(query)) return true
    if (entry.description.toLowerCase().includes(query)) return true
    if (entry.tags?.some((tag) => tag.toLowerCase().includes(query))) return true
    return false
  }

  const hasSources = sources.length > 0
  const previewMinutes = preview ? Math.max(0, Math.round((preview.expiresAt - Date.now()) / 60000)) : 0

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="crumbs">
          <span>Whales</span>
          <span>/</span>
          <strong>Marketplace</strong>
        </div>
      </div>
      <div className="panel-body">
        <div className="page">
          <h1 className="page-title">Marketplace</h1>
          <p className="page-sub">
            Add plugins, then switch them on per chat or per room. Plugins are third-party code that runs on your
            computer with full access, so install only what you trust.
          </p>

          <div className="tabs">
            <button className={'tab' + (tab === 'discover' ? ' tab-active' : '')} onClick={() => setTab('discover')}>
              Discover
            </button>
            <button className={'tab' + (tab === 'installed' ? ' tab-active' : '')} onClick={() => setTab('installed')}>
              Installed ({installed.length})
            </button>
            <button className={'tab' + (tab === 'sources' ? ' tab-active' : '')} onClick={() => setTab('sources')}>
              Sources
            </button>
          </div>

          {confirmation ? <div className="note-ok">{confirmation}</div> : null}

          {tab === 'discover' ? (
            <div>
              <div className="row">
                <button className="btn btn-sm" onClick={() => void runBrowse()} disabled={browsing}>
                  {browsing ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>

              {browseError ? <div className="error">{browseError}</div> : null}

              {!hasSources && sourcesLoaded ? (
                <div className="empty">
                  <p>No plugin sources yet. Add an index in Sources to browse plugins.</p>
                  <button className="btn btn-sm" onClick={() => setTab('sources')}>
                    Go to Sources
                  </button>
                </div>
              ) : null}

              {hasSources ? (
                <div>
                  <input
                    className="input"
                    placeholder="Search plugins"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />

                  {browse.map((result) => {
                    if (result.error) {
                      return (
                        <div className="error" key={result.source}>
                          {result.source}: {result.error}
                        </div>
                      )
                    }
                    const entries = result.entries.filter(matches)
                    if (entries.length === 0) return null
                    return (
                      <div key={result.source}>
                        <div className="card-grid">
                          {entries.map((entry) => {
                            const key = `${result.source}:${entry.name}`
                            const current = installedByName.get(entry.name)
                            const sameVersion = current !== undefined && current.manifest.version === entry.version
                            const busy = busyKey === key
                            return (
                              <div className="card" key={key}>
                                <div className="card-head">
                                  <span>{entry.name}</span>
                                  <span className="badge">v{entry.version}</span>
                                </div>
                                <div className="card-desc">{entry.description}</div>
                                <div className="card-meta">
                                  {entry.tags?.map((tag) => (
                                    <span className="tag" key={tag}>
                                      {tag}
                                    </span>
                                  ))}
                                  {entry.author ? <span>{entry.author}</span> : null}
                                  {entry.license ? <span>{entry.license}</span> : null}
                                  {entry.scopes?.map((scope) => (
                                    <span className="tag" key={scope}>
                                      {scopeLabel(scope)}
                                    </span>
                                  ))}
                                </div>
                                <div className="row">
                                  {sameVersion ? (
                                    <span className="badge badge-ok">Installed</span>
                                  ) : (
                                    <button
                                      className="btn btn-primary btn-sm"
                                      disabled={busy}
                                      onClick={() => void openPreview(key, { source: result.source, name: entry.name })}
                                    >
                                      {busy ? 'Fetching…' : current ? 'Update' : 'Install'}
                                    </button>
                                  )}
                                </div>
                                {cardError && cardError.key === key ? <div className="error">{cardError.message}</div> : null}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : null}

              <details>
                <summary>Install from GitHub or a folder</summary>
                <div>
                  <div className="row">
                    <input
                      className="input"
                      placeholder="https://github.com/owner/repo"
                      value={repoUrl}
                      onChange={(event) => setRepoUrl(event.target.value)}
                    />
                    <input
                      className="input"
                      placeholder="40-character commit hash"
                      value={repoCommit}
                      onChange={(event) => setRepoCommit(event.target.value)}
                    />
                    <input
                      className="input"
                      placeholder="sub-folder (optional)"
                      value={repoPath}
                      onChange={(event) => setRepoPath(event.target.value)}
                    />
                    <button className="btn btn-sm" onClick={submitRepo} disabled={busyKey === 'form:repo'}>
                      {busyKey === 'form:repo' ? 'Fetching…' : 'Preview'}
                    </button>
                  </div>
                  {repoCommit.trim() && !commitValid ? (
                    <div className="muted">Commit must be a full 40-character lowercase hex hash.</div>
                  ) : null}
                </div>
                <div>
                  <div className="row">
                    <input
                      className="input"
                      placeholder="/absolute/path/to/plugin"
                      value={localPath}
                      onChange={(event) => setLocalPath(event.target.value)}
                    />
                    <button className="btn btn-sm" onClick={submitLocal} disabled={busyKey === 'form:local'}>
                      {busyKey === 'form:local' ? 'Fetching…' : 'Preview'}
                    </button>
                  </div>
                </div>
                {formError ? <div className="error">{formError}</div> : null}
              </details>
            </div>
          ) : null}

          {tab === 'installed' ? (
            <div>
              {installedError ? <div className="error">{installedError}</div> : null}
              {installedLoaded && installed.length === 0 ? (
                <div className="empty">No plugins installed yet. Browse the Discover tab to add one.</div>
              ) : null}
              {installed.length > 0 ? (
                <div className="list">
                  {installed.map((plugin) => {
                    const used = plugin.usedBy.agents.length > 0 || plugin.usedBy.rooms.length > 0
                    const usedText = used
                      ? `Used by: ${[
                          ...plugin.usedBy.agents.map((id) => `agent ${id}`),
                          ...plugin.usedBy.rooms.map((id) => `room ${id}`),
                        ].join(', ')}`
                      : 'Not used yet'
                    return (
                      <div className="list-row" key={plugin.name}>
                        <div className="grow">
                          <div>
                            <strong>{plugin.name}</strong> <span className="muted">v{plugin.manifest.version}</span>{' '}
                            {plugin.state === 'loaded' ? <span className="badge badge-ok">Loaded</span> : null}
                            {plugin.state === 'failed' ? <span className="badge badge-danger">Failed</span> : null}
                            {plugin.state === 'pending-restart' ? (
                              <span className="badge badge-warn">Restart needed</span>
                            ) : null}
                          </div>
                          <div className="muted">{plugin.manifest.description}</div>
                          <div className="muted">
                            {plugin.origin.kind === 'github' ? (
                              <span>
                                <span className="mono">{plugin.origin.repo}</span> @{' '}
                                <span className="mono">{plugin.origin.commit.slice(0, 12)}</span>
                              </span>
                            ) : (
                              <span>
                                local folder <span className="mono">{plugin.origin.path}</span>
                              </span>
                            )}
                          </div>
                          {plugin.error ? <div className="error">{plugin.error}</div> : null}
                          <div className="muted">{usedText}</div>
                        </div>
                        <button
                          className="btn btn-danger btn-sm"
                          disabled={used}
                          title={used ? 'Remove it from those chats and rooms first' : undefined}
                          onClick={() => void uninstall(plugin.name)}
                        >
                          Uninstall
                        </button>
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === 'sources' ? (
            <div>
              <p className="page-sub">
                A source is an index file (JSON) listing plugins pinned to exact GitHub commits. Paste its https URL,
                e.g. a raw.githubusercontent.com link.
              </p>
              <div className="row">
                <input
                  className="input"
                  placeholder="https://raw.githubusercontent.com/owner/repo/main/index.json"
                  value={newSourceUrl}
                  onChange={(event) => setNewSourceUrl(event.target.value)}
                />
                <button className="btn btn-primary btn-sm" onClick={() => void addSource()} disabled={addingSource}>
                  {addingSource ? 'Adding…' : 'Add source'}
                </button>
              </div>
              {sourceFormError ? <div className="error">{sourceFormError}</div> : null}
              {sourcesError ? <div className="error">{sourcesError}</div> : null}

              {sourcesLoaded && sources.length === 0 ? <div className="empty">No sources added yet.</div> : null}
              {sources.length > 0 ? (
                <div className="list">
                  {sources.map((source) => (
                    <div className="list-row" key={source.id}>
                      <div className="grow">
                        <span className="mono">{source.url}</span>
                      </div>
                      <button className="btn btn-ghost btn-sm" onClick={() => void removeSource(source)}>
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <details>
                <summary>Index format</summary>
                <pre className="tool-io">{INDEX_EXAMPLE}</pre>
              </details>
            </div>
          ) : null}
        </div>
      </div>

      {preview ? (
        <div className="modal-backdrop" onClick={closePreview}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>
              Install {preview.manifest.name} {preview.manifest.version}
            </h2>
            <p>{preview.manifest.description}</p>
            <div className="muted">
              {preview.origin.kind === 'github' ? (
                <span>
                  <span className="mono">{preview.origin.repo}</span> @{' '}
                  <span className="mono">{preview.origin.commit.slice(0, 12)}</span>
                  {preview.origin.path ? (
                    <span>
                      {' '}
                      path <span className="mono">{preview.origin.path}</span>
                    </span>
                  ) : null}
                  {preview.origin.index ? (
                    <span>
                      {' '}
                      index <span className="mono">{preview.origin.index}</span>
                    </span>
                  ) : null}
                </span>
              ) : (
                <span>
                  local folder <span className="mono">{preview.origin.path}</span>
                </span>
              )}
            </div>
            <div className="muted">
              {preview.files.length} files · {humanSize(preview.totalBytes)}
            </div>
            <div className="file-list">
              {preview.files.map((file) => (
                <div key={file.path}>
                  <span className="mono">{file.path}</span> <span className="muted">{humanSize(file.bytes)}</span>
                </div>
              ))}
            </div>
            <div className="muted">
              Content hash{' '}
              <span className="mono" title={preview.digest}>
                {preview.digest.slice(0, 16)}…
              </span>
            </div>
            {preview.warnings.map((warning) => (
              <div className="warning" key={warning}>
                {warning}
              </div>
            ))}
            <div className="danger-note">
              This plugin will run inside Whales with the same access to your computer as Whales itself. Only install it
              if you trust its author.
            </div>
            <label>
              <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />I understand and
              want to install this plugin
            </label>
            <div className="muted">Preview expires in {previewMinutes} min</div>
            {previewError ? <div className="error">{previewError}</div> : null}
            <div className="modal-actions">
              <button className="btn" onClick={closePreview} disabled={installing}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void confirmInstall()} disabled={!ack || installing}>
                {installing ? 'Installing…' : 'Install'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
