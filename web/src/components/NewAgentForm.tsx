import { useEffect, useState } from 'react'
import { api, ApiError } from '../api.ts'
import type { AgentSpec, AgentView, PluginRef, Provider } from '../types.ts'

/** '' = not chosen yet; 'stub' = test driver; anything else is a provider id from the Models page. */
type DriverChoice = string

export function NewAgentForm(props: { onCreated(agent: AgentView): void; onCancel(): void; onOpenModels(): void }) {
  const { onCreated, onCancel, onOpenModels } = props
  const [providers, setProviders] = useState<Provider[] | undefined>(undefined)
  const [model, setModel] = useState('')
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [instructions, setInstructions] = useState('')
  const [seniority, setSeniority] = useState(1)
  const [driver, setDriver] = useState<DriverChoice>('')
  const [memory, setMemory] = useState(false)
  const [workspace, setWorkspace] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .providers()
      .then((res) => {
        if (cancelled) return
        setProviders(res.providers)
        const first = res.providers[0]
        setDriver(first ? first.id : 'stub')
        setModel(first?.defaultModel ?? first?.models[0] ?? '')
      })
      .catch(() => {
        if (!cancelled) setProviders([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const provider = providers?.find((p) => p.id === driver)

  const chooseDriver = (value: string): void => {
    setDriver(value)
    const next = providers?.find((p) => p.id === value)
    setModel(next?.defaultModel ?? next?.models[0] ?? '')
  }

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setError(undefined)
    setBusy(true)
    try {
      if (driver !== 'stub' && !provider) throw new Error('Choose a model provider first (add one on the Models page).')
      if (driver !== 'stub' && !model.trim()) throw new Error('Choose or type a model.')
      const driverRef: PluginRef =
        driver === 'stub'
          ? { name: 'driver-stub', config: { template: 'echo: {prompt}' } }
          : { name: 'driver-openai-compat', config: { provider: driver, model: model.trim() } }
      const plugins: PluginRef[] = []
      if (memory) plugins.push({ name: 'memory' })
      if (workspace) plugins.push({ name: 'workspace' })
      const spec: AgentSpec = {
        id: id.trim(),
        name: name.trim(),
        seniority,
        driver: driverRef,
        plugins,
      }
      if (role.trim()) spec.role = role.trim()
      if (instructions.trim()) spec.instructions = instructions.trim()
      const agent = await api.createAgent(spec)
      onCreated(agent)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span>New agent</span>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className="panel-body">
        <form className="form" onSubmit={(e) => void submit(e)}>
          <label className="field">
            <span>ID</span>
            <input value={id} onChange={(e) => setId(e.target.value)} required />
          </label>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="field">
            <span>Role</span>
            <input value={role} onChange={(e) => setRole(e.target.value)} />
          </label>
          <label className="field">
            <span>Instructions</span>
            <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={5} />
          </label>
          <label className="field">
            <span>Seniority</span>
            <input
              type="number"
              value={seniority}
              min={1}
              onChange={(e) => setSeniority(Number(e.target.value) || 1)}
            />
          </label>
          <label className="field">
            <span>Model provider</span>
            <select value={driver} onChange={(e) => chooseDriver(e.target.value)}>
              {providers === undefined ? <option value="">Loading…</option> : null}
              {providers?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.key === 'none' && p.kind !== 'ollama' && p.kind !== 'custom' ? ' (no key yet)' : ''}
                </option>
              ))}
              <option value="stub">Stub (testing, no model)</option>
            </select>
          </label>
          {providers !== undefined && providers.length === 0 ? (
            <div className="muted">
              No model providers yet.{' '}
              <button type="button" className="btn btn-sm" onClick={onOpenModels}>
                Add DeepSeek, OpenAI or OpenCode
              </button>
            </div>
          ) : null}
          {provider ? (
            <label className="field">
              <span>Model</span>
              <input value={model} onChange={(e) => setModel(e.target.value)} list="provider-models" placeholder="model id" />
              <datalist id="provider-models">
                {provider.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
          ) : null}
          <label className="row">
            <input type="checkbox" checked={memory} onChange={(e) => setMemory(e.target.checked)} />
            <span>Memory</span>
          </label>
          <label className="row">
            <input type="checkbox" checked={workspace} onChange={(e) => setWorkspace(e.target.checked)} />
            <span>Workspace (file tools)</span>
          </label>
          {error ? <div className="error">{error}</div> : null}
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create agent'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
