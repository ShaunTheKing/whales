import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '../api.ts'
import { SearchSettings } from './SearchSettings.tsx'
import type { Provider, ProviderInput, ProviderKind, ProviderPreset } from '../types.ts'

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

function presetLabel(kind: ProviderKind): string {
  switch (kind) {
    case 'deepseek':
      return 'DeepSeek'
    case 'openai':
      return 'OpenAI'
    case 'opencode':
      return 'OpenCode Zen'
    case 'opencode-go':
      return 'OpenCode Go'
    case 'openrouter':
      return 'OpenRouter'
    case 'ollama':
      return 'Ollama'
    case 'custom':
      return 'Custom OpenAI-compatible'
  }
}

function parseModels(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const id = raw.trim()
    if (!id) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

interface TestResult {
  ok: boolean
  models: string[]
  error?: string
}

interface EditState {
  name: string
  baseUrl: string
  defaultModel: string
  modelsText: string
  keyEnv: string
  apiKey: string
}

interface AddState {
  preset: ProviderPreset
  name: string
  baseUrl: string
  apiKey: string
  modelsText: string
  defaultModel: string
}

export function ModelsView(props: { onChanged(): void }) {
  const { onChanged } = props
  const mounted = useRef(true)
  const [providers, setProviders] = useState<Provider[]>([])
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [secretStore, setSecretStore] = useState<'keychain' | 'memory' | 'none'>('keychain')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)

  const [editingId, setEditingId] = useState<string | undefined>(undefined)
  const [edit, setEdit] = useState<EditState | undefined>(undefined)
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState<string | undefined>(undefined)

  const [testingId, setTestingId] = useState<string | undefined>(undefined)
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({})

  const [addOpen, setAddOpen] = useState(false)
  const [add, setAdd] = useState<AddState | undefined>(undefined)
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | undefined>(undefined)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const res = await api.providers()
      if (!mounted.current) return
      setProviders(res.providers)
      setPresets(res.presets)
      setSecretStore(res.secretStore)
      setLoadError(undefined)
    } catch (err) {
      if (!mounted.current) return
      setLoadError(errorText(err))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const presetByKind = useMemo(() => {
    const map = new Map<ProviderKind, ProviderPreset>()
    for (const p of presets) map.set(p.kind, p)
    return map
  }, [presets])

  const presetFor = useCallback(
    (kind: ProviderKind): ProviderPreset | undefined => presetByKind.get(kind),
    [presetByKind],
  )

  const runTest = useCallback(
    async (id: string) => {
      setTestingId(id)
      try {
        const result = await api.testProvider(id)
        if (!mounted.current) return
        setTestResults((prev) => ({ ...prev, [id]: result }))
      } catch (err) {
        if (!mounted.current) return
        setTestResults((prev) => ({ ...prev, [id]: { ok: false, models: [], error: errorText(err) } }))
      } finally {
        if (mounted.current) setTestingId((cur) => (cur === id ? undefined : cur))
      }
    },
    [],
  )

  const openEdit = useCallback((provider: Provider) => {
    setEditingId(provider.id)
    setEditError(undefined)
    setEdit({
      name: provider.name,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel ?? '',
      modelsText: provider.models.join('\n'),
      keyEnv: provider.keyEnv ?? '',
      apiKey: '',
    })
  }, [])

  const closeEdit = useCallback(() => {
    setEditingId(undefined)
    setEdit(undefined)
    setEditError(undefined)
    setEditBusy(false)
  }, [])

  const saveEdit = useCallback(
    async (provider: Provider) => {
      if (!edit) return
      setEditBusy(true)
      setEditError(undefined)
      try {
        const patch: {
          name?: string
          baseUrl?: string
          models?: string[]
          defaultModel?: string
          keyEnv?: string
        } = {}
        const name = edit.name.trim()
        if (name && name !== provider.name) patch.name = name
        const baseUrl = edit.baseUrl.trim()
        if ((provider.kind === 'custom' || provider.kind === 'ollama') && baseUrl && baseUrl !== provider.baseUrl) {
          patch.baseUrl = baseUrl
        }
        const models = parseModels(edit.modelsText)
        if (models.join('\n') !== provider.models.join('\n')) patch.models = models
        const defaultModel = edit.defaultModel.trim()
        if (defaultModel !== (provider.defaultModel ?? '')) {
          if (defaultModel) patch.defaultModel = defaultModel
        }
        const keyEnv = edit.keyEnv.trim()
        if (keyEnv !== (provider.keyEnv ?? '')) {
          if (keyEnv) patch.keyEnv = keyEnv
        }
        if (Object.keys(patch).length > 0) {
          await api.updateProvider(provider.id, patch)
        }
        if (!mounted.current) return
        closeEdit()
        await load()
        onChanged()
      } catch (err) {
        if (!mounted.current) return
        setEditError(errorText(err))
      } finally {
        if (mounted.current) setEditBusy(false)
      }
    },
    [edit, closeEdit, load, onChanged],
  )

  const saveKey = useCallback(
    async (provider: Provider) => {
      if (!edit) return
      const key = edit.apiKey
      if (!key) return
      setEditBusy(true)
      setEditError(undefined)
      try {
        await api.setProviderKey(provider.id, key)
        if (!mounted.current) return
        setEdit((cur) => (cur ? { ...cur, apiKey: '' } : cur))
        await load()
        onChanged()
      } catch (err) {
        if (!mounted.current) return
        setEdit((cur) => (cur ? { ...cur, apiKey: '' } : cur))
        setEditError(errorText(err))
      } finally {
        if (mounted.current) setEditBusy(false)
      }
    },
    [edit, load, onChanged],
  )

  const clearKey = useCallback(
    async (provider: Provider) => {
      if (!window.confirm(`Delete the saved key for ${provider.name}?`)) return
      setEditBusy(true)
      setEditError(undefined)
      try {
        await api.clearProviderKey(provider.id)
        if (!mounted.current) return
        await load()
        onChanged()
      } catch (err) {
        if (!mounted.current) return
        setEditError(errorText(err))
      } finally {
        if (mounted.current) setEditBusy(false)
      }
    },
    [load, onChanged],
  )

  const removeProvider = useCallback(
    async (provider: Provider) => {
      if (provider.usedBy.length > 0) return
      if (!window.confirm(`Remove ${provider.name}? Its Keychain key is deleted too.`)) return
      try {
        await api.deleteProvider(provider.id)
        if (!mounted.current) return
        if (editingId === provider.id) closeEdit()
        await load()
        onChanged()
      } catch (err) {
        if (!mounted.current) return
        setLoadError(errorText(err))
      }
    },
    [editingId, closeEdit, load, onChanged],
  )

  const useTheseModels = useCallback(
    async (provider: Provider, result: TestResult) => {
      try {
        const patch: { models: string[]; defaultModel?: string } = {
          models: result.models.slice(0, 200),
        }
        const fallback = result.models[0]
        const chosen = provider.defaultModel ?? fallback
        if (chosen !== undefined) patch.defaultModel = chosen
        await api.updateProvider(provider.id, patch)
        if (!mounted.current) return
        await load()
        onChanged()
      } catch (err) {
        if (!mounted.current) return
        setTestResults((prev) => ({ ...prev, [provider.id]: { ok: false, models: [], error: errorText(err) } }))
      }
    },
    [load, onChanged],
  )

  const openAdd = useCallback(() => {
    setAddOpen(true)
    setAdd(undefined)
    setAddError(undefined)
    setAddBusy(false)
  }, [])

  const closeAdd = useCallback(() => {
    setAddOpen(false)
    setAdd(undefined)
    setAddError(undefined)
    setAddBusy(false)
  }, [])

  const choosePreset = useCallback((preset: ProviderPreset) => {
    setAdd({
      preset,
      name: preset.label,
      baseUrl: preset.baseUrl,
      apiKey: '',
      modelsText: preset.models.join('\n'),
      defaultModel: preset.models[0] ?? '',
    })
    setAddError(undefined)
  }, [])

  const saveAdd = useCallback(async () => {
    if (!add) return
    setAddBusy(true)
    setAddError(undefined)
    try {
      const input: ProviderInput = { kind: add.preset.kind }
      const name = add.name.trim()
      if (name) input.name = name
      const baseUrl = add.baseUrl.trim()
      if (add.preset.kind === 'custom' || add.preset.kind === 'ollama') {
        if (baseUrl) input.baseUrl = baseUrl
      }
      const models = parseModels(add.modelsText)
      if (models.length > 0) input.models = models
      const defaultModel = add.defaultModel.trim()
      if (defaultModel) input.defaultModel = defaultModel
      const apiKey = add.apiKey
      if (apiKey) input.apiKey = apiKey
      const created = await api.createProvider(input)
      if (!mounted.current) return
      setAdd((cur) => (cur ? { ...cur, apiKey: '' } : cur))
      closeAdd()
      await load()
      onChanged()
      await runTest(created.id)
    } catch (err) {
      if (!mounted.current) return
      setAdd((cur) => (cur ? { ...cur, apiKey: '' } : cur))
      setAddError(errorText(err))
    } finally {
      if (mounted.current) setAddBusy(false)
    }
  }, [add, closeAdd, load, onChanged, runTest])

  useEffect(() => {
    if (!addOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAdd()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addOpen, closeAdd])

  const renderKeyBadge = (provider: Provider) => {
    const preset = presetFor(provider.kind)
    if (provider.key === 'keychain') return <span className="badge badge-ok">Key in Keychain</span>
    if (provider.key === 'env') return <span className="badge">Key from {provider.keyEnv ?? 'environment'}</span>
    if (preset?.needsKey) return <span className="badge badge-warn">No key</span>
    return <span className="badge">No key needed</span>
  }

  const renderEditor = (provider: Provider) => {
    if (!edit) return null
    const preset = presetFor(provider.kind)
    const baseUrlEditable = provider.kind === 'custom' || provider.kind === 'ollama'
    const modelOptions = provider.models.slice()
    if (edit.defaultModel && !modelOptions.includes(edit.defaultModel)) modelOptions.push(edit.defaultModel)
    return (
      <div className="stack" style={{ marginTop: 12 }}>
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            value={edit.name}
            onChange={(e) => setEdit({ ...edit, name: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Base URL</span>
          {baseUrlEditable ? (
            <input
              className="input"
              value={edit.baseUrl}
              onChange={(e) => setEdit({ ...edit, baseUrl: e.target.value })}
            />
          ) : (
            <span className="mono">{provider.baseUrl}</span>
          )}
        </label>
        <label className="field">
          <span>Default model</span>
          <select
            className="input"
            value={edit.defaultModel}
            onChange={(e) => setEdit({ ...edit, defaultModel: e.target.value })}
          >
            <option value="">(none)</option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>or type a model id</span>
          <input
            className="input"
            value={edit.defaultModel}
            onChange={(e) => setEdit({ ...edit, defaultModel: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Models (one id per line)</span>
          <textarea
            className="input"
            rows={5}
            value={edit.modelsText}
            onChange={(e) => setEdit({ ...edit, modelsText: e.target.value })}
          />
        </label>
        <div className="field">
          <span>API key</span>
          <div className="row">
            <input
              className="input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste a new key to replace"
              value={edit.apiKey}
              onChange={(e) => setEdit({ ...edit, apiKey: e.target.value })}
            />
            <button
              className="btn btn-sm"
              disabled={editBusy || !edit.apiKey}
              onClick={() => void saveKey(provider)}
            >
              Save key
            </button>
            {provider.key === 'keychain' ? (
              <button
                className="btn btn-danger btn-sm"
                disabled={editBusy}
                onClick={() => void clearKey(provider)}
              >
                Delete saved key
              </button>
            ) : null}
          </div>
        </div>
        <label className="field">
          <span>Environment variable fallback</span>
          <input
            className="input"
            placeholder={preset?.keyEnv ?? 'DEEPSEEK_API_KEY'}
            value={edit.keyEnv}
            onChange={(e) => setEdit({ ...edit, keyEnv: e.target.value })}
          />
        </label>
        {editError ? <div className="error">{editError}</div> : null}
        <div className="row">
          <button className="btn btn-primary btn-sm" disabled={editBusy} onClick={() => void saveEdit(provider)}>
            {editBusy ? 'Saving…' : 'Save'}
          </button>
          <button className="btn btn-sm" disabled={editBusy} onClick={closeEdit}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  const renderRow = (provider: Provider) => {
    const preset = presetFor(provider.kind)
    const result = testResults[provider.id]
    const testing = testingId === provider.id
    const usedBy = provider.usedBy
    const modelsDiffer =
      result?.ok === true &&
      (provider.models.length === 0 ||
        provider.models.length !== result.models.length ||
        provider.models.some((m) => !result.models.includes(m)))
    return (
      <div className="list-row" key={provider.id}>
        <div className="grow">
          <div>
            <strong>{provider.name}</strong> <span className="muted">{presetLabel(provider.kind)}</span>{' '}
            {renderKeyBadge(provider)}
          </div>
          <div>
            <span className="mono">{provider.baseUrl}</span>
          </div>
          <div className="muted">
            {provider.defaultModel ? provider.defaultModel : 'no default model'}
            {usedBy.length > 0 ? ` · used by ${usedBy.length} agents` : ''}
          </div>
          {result ? (
            result.ok ? (
              <div>
                <div className="note-ok">Connected · {result.models.length} models available</div>
                {modelsDiffer ? (
                  <button className="btn btn-sm" onClick={() => void useTheseModels(provider, result)}>
                    Use these models
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="error">{result.error ?? 'Test failed'}</div>
            )
          ) : null}
          {editingId === provider.id ? renderEditor(provider) : null}
        </div>
        <div className="row">
          <button className="btn btn-sm" disabled={testing} onClick={() => void runTest(provider.id)}>
            {testing ? 'Testing…' : 'Test'}
          </button>
          <button className="btn btn-sm" onClick={() => openEdit(provider)}>
            Edit
          </button>
          <button
            className="btn btn-danger btn-sm"
            disabled={usedBy.length > 0}
            title={usedBy.length > 0 ? `Used by agents: ${usedBy.join(', ')}` : undefined}
            onClick={() => void removeProvider(provider)}
          >
            Remove
          </button>
        </div>
      </div>
    )
  }

  const renderAddModal = () => {
    if (!addOpen) return null
    return (
      <div className="modal-backdrop" onClick={closeAdd}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h2>Add a model provider</h2>
          {!add ? (
            <div className="card-grid">
              {presets.map((preset) => (
                <button
                  key={preset.kind}
                  className="card"
                  style={{ textAlign: 'left' }}
                  onClick={() => choosePreset(preset)}
                >
                  <strong>{preset.label}</strong>
                  <div className="muted">
                    {preset.kind === 'custom' ? 'Any OpenAI-compatible API' : preset.baseUrl}
                  </div>
                  <div className="muted">
                    {preset.needsKey ? 'needs an API key' : preset.kind === 'custom' ? 'any URL, key optional' : 'runs locally, no key'}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="stack">
              <label className="field">
                <span>Name</span>
                <input
                  className="input"
                  value={add.name}
                  onChange={(e) => setAdd({ ...add, name: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Base URL</span>
                {add.preset.kind === 'custom' || add.preset.kind === 'ollama' ? (
                  <input
                    className="input"
                    value={add.baseUrl}
                    onChange={(e) => setAdd({ ...add, baseUrl: e.target.value })}
                  />
                ) : (
                  <span className="mono">{add.preset.baseUrl}</span>
                )}
              </label>
              {add.preset.needsKey || add.preset.kind === 'custom' ? (
                <label className="field">
                  <span>{add.preset.kind === 'custom' ? 'API key (optional)' : 'API key'}</span>
                  <input
                    className="input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={add.apiKey}
                    onChange={(e) => setAdd({ ...add, apiKey: e.target.value })}
                  />
                  <span className="muted">Saved to your Mac's Keychain. Whales never shows it again.</span>
                </label>
              ) : null}
              <label className="field">
                <span>Models (one id per line)</span>
                <textarea
                  className="input"
                  rows={5}
                  value={add.modelsText}
                  onChange={(e) => setAdd({ ...add, modelsText: e.target.value })}
                />
                <span className="muted">Leave empty and use Test to fetch the list</span>
              </label>
              <label className="field">
                <span>Default model</span>
                <input
                  className="input"
                  value={add.defaultModel}
                  onChange={(e) => setAdd({ ...add, defaultModel: e.target.value })}
                />
              </label>
              {add.preset.docs ? (
                <div className="muted">
                  Get a key: <span className="mono">{add.preset.docs}</span>
                </div>
              ) : null}
              {add.preset.needsKey && !add.apiKey ? (
                <div className="muted">No key entered — you can add one later or use an environment variable.</div>
              ) : null}
              {addError ? <div className="error">{addError}</div> : null}
              <div className="row">
                <button className="btn btn-sm" disabled={addBusy} onClick={() => setAdd(undefined)}>
                  Back
                </button>
                <button className="btn btn-sm" disabled={addBusy} onClick={closeAdd}>
                  Cancel
                </button>
                <button className="btn btn-primary" disabled={addBusy} onClick={() => void saveAdd()}>
                  {addBusy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="crumbs">
          <span>Whales</span>
          <span>/</span>
          <strong>Models</strong>
        </div>
        <button className="btn btn-primary btn-sm" onClick={openAdd}>
          Add provider
        </button>
      </div>
      <div className="panel-body">
        <div className="page">
          <h1 className="page-title">Models</h1>
          <p className="page-sub">
            Connect model providers. API keys are saved in your Mac's Keychain, never in Whales' database or files.
          </p>
          {secretStore === 'none' ? (
            <div className="warning">
              This system has no Keychain. Set the provider's environment variable (e.g. DEEPSEEK_API_KEY) instead of
              saving a key here.
            </div>
          ) : null}
          {secretStore === 'memory' ? (
            <div className="warning">Keys are kept in memory only (test mode).</div>
          ) : null}
          {loadError ? <div className="error">{loadError}</div> : null}
          {loading ? (
            <div className="muted">Loading…</div>
          ) : providers.length === 0 ? (
            <div className="empty">
              No providers yet. Add DeepSeek, OpenAI or OpenCode to start chatting with real models.
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn btn-primary btn-sm" onClick={openAdd}>
                  Add provider
                </button>
              </div>
            </div>
          ) : (
            <div className="list">{providers.map(renderRow)}</div>
          )}
          <SearchSettings />
        </div>
      </div>
      {renderAddModal()}
    </div>
  )
}
