import { useState } from 'react'
import { api, ApiError } from '../api.ts'
import type { AgentSpec, AgentView, PluginRef } from '../types.ts'

type DriverChoice = 'deepseek' | 'ollama' | 'stub'

const DRIVERS: Record<DriverChoice, { label: string; preset?: string; model?: string }> = {
  deepseek: { label: 'DeepSeek chat', preset: 'deepseek', model: 'deepseek-chat' },
  ollama: { label: 'Ollama', preset: 'ollama', model: 'text' },
  stub: { label: 'Stub (testing)' },
}

export function NewAgentForm(props: { onCreated(agent: AgentView): void; onCancel(): void }) {
  const { onCreated, onCancel } = props
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [instructions, setInstructions] = useState('')
  const [seniority, setSeniority] = useState(1)
  const [driver, setDriver] = useState<DriverChoice>('deepseek')
  const [memory, setMemory] = useState(false)
  const [workspace, setWorkspace] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setError(undefined)
    setBusy(true)
    try {
      const choice = DRIVERS[driver]
      const driverRef: PluginRef =
        driver === 'stub'
          ? { name: 'driver-stub', config: { template: 'echo: {prompt}' } }
          : { name: 'driver-openai-compat', config: { preset: choice.preset, model: choice.model } }
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
            <span>Driver</span>
            <select value={driver} onChange={(e) => setDriver(e.target.value as DriverChoice)}>
              <option value="deepseek">{DRIVERS.deepseek.label}</option>
              <option value="ollama">{DRIVERS.ollama.label}</option>
              <option value="stub">{DRIVERS.stub.label}</option>
            </select>
          </label>
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
