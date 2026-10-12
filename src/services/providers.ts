import { Service, type Context } from 'cordis'
import type { ProviderInput, ProviderKind, ProviderPreset, ProviderRecord, ProviderView, ProvidersService } from '../contracts/providers.ts'
import { MacKeychain, MemorySecrets, assertApiKey, type SecretStore } from '../core/keychain.ts'

/**
 * SECURITY-CRITICAL (orchestrator-owned). Model providers + their keys. Keys go to the SecretStore (macOS Keychain)
 * and are only read back for a driver request or a connection test; they are never stored in records, returned by any
 * method except resolveKey, or included in errors (every error is redacted with the key in hand).
 */

export interface ProvidersConfig {
  /** Default: the macOS Keychain on darwin, otherwise none (env vars only). Tests pass a MemorySecrets. */
  secrets?: SecretStore | false
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { kind: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY', needsKey: true, models: ['deepseek-chat', 'deepseek-reasoner'], docs: 'https://platform.deepseek.com/api_keys' },
  { kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', needsKey: true, models: [], docs: 'https://platform.openai.com/api-keys' },
  { kind: 'opencode', label: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', keyEnv: 'OPENCODE_API_KEY', needsKey: true, models: [], docs: 'https://opencode.ai/docs/zen' },
  { kind: 'opencode-go', label: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', keyEnv: 'OPENCODE_GO_API_KEY', needsKey: true, models: [], docs: 'https://opencode.ai/docs/go' },
  { kind: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', needsKey: true, models: [], docs: 'https://openrouter.ai/keys' },
  { kind: 'ollama', label: 'Ollama (local)', baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false, models: [] },
  { kind: 'custom', label: 'Custom (OpenAI-compatible)', baseUrl: '', needsKey: false, models: [] },
]

const KINDS = new Set<ProviderKind>(PROVIDER_PRESETS.map((p) => p.kind))
const MODEL = /^[\w.:/@+-]{1,128}$/
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const MAX_MODELS = 500
const TEST_TIMEOUT = 15_000

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function checkBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) throw new TypeError('base URL is required')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new TypeError('base URL is not a valid URL')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new TypeError('base URL must use https (plain http only for localhost)')
  }
  if (url.username || url.password || url.search || url.hash) throw new TypeError('base URL must not contain credentials, a query or a fragment')
  return url.href.replace(/\/+$/, '')
}

function checkModels(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_MODELS || !value.every((m) => typeof m === 'string' && MODEL.test(m))) {
    throw new TypeError('models must be a list of model ids')
  }
  return [...new Set(value as string[])]
}

export class Providers extends Service implements ProvidersService {
  static inject = ['store']

  readonly secretStore: 'keychain' | 'memory' | 'none'
  private own: Context
  private secrets: SecretStore | undefined

  constructor(ctx: Context, config: ProvidersConfig = {}) {
    super(ctx, 'providers')
    this.own = ctx
    this.secrets = config.secrets === false ? undefined : (config.secrets ?? (process.platform === 'darwin' ? new MacKeychain() : undefined))
    this.secretStore = this.secrets?.kind ?? 'none'
  }

  presets(): ProviderPreset[] {
    return PROVIDER_PRESETS.map((p) => ({ ...p, models: [...p.models] }))
  }

  async list(): Promise<ProviderView[]> {
    return Promise.all(this.col().list().map((r) => this.view(r)))
  }

  get(id: string): ProviderRecord | undefined {
    return this.col().get(id)
  }

  async create(input: ProviderInput): Promise<ProviderView> {
    if (!input || typeof input !== 'object' || !KINDS.has(input.kind)) throw new TypeError('kind must be one of ' + [...KINDS].join(', '))
    const preset = PROVIDER_PRESETS.find((p) => p.kind === input.kind)!
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 64) : preset.label
    const baseUrl = checkBaseUrl(input.baseUrl ?? preset.baseUrl)
    const models = checkModels(input.models ?? preset.models)
    if (input.apiKey !== undefined) {
      assertApiKey(input.apiKey)
      this.requireSecrets()
      this.keyTransport(baseUrl)
    }
    const record: ProviderRecord = { id: this.newId(input.kind), scope: 'global', createdAt: Date.now(), name, kind: input.kind, baseUrl, models }
    const defaultModel = input.defaultModel ?? models[0]
    if (defaultModel !== undefined) record.defaultModel = this.checkDefault(defaultModel)
    const keyEnv = input.keyEnv ?? preset.keyEnv
    if (keyEnv !== undefined) record.keyEnv = this.checkEnv(keyEnv)
    // Key first: a provider is never saved pointing at a key that failed to store.
    if (input.apiKey !== undefined) await this.secrets!.set(record.id, input.apiKey, `Whales: ${name}`)
    this.col().put(record)
    return this.view(record)
  }

  async update(id: string, patch: Partial<Pick<ProviderRecord, 'name' | 'baseUrl' | 'models' | 'defaultModel' | 'keyEnv'>>): Promise<ProviderView> {
    const record = this.require(id)
    const next: ProviderRecord = { ...record }
    if (patch.name !== undefined) {
      if (typeof patch.name !== 'string' || !patch.name.trim()) throw new TypeError('name must be a non-empty string')
      next.name = patch.name.trim().slice(0, 64)
    }
    if (patch.baseUrl !== undefined) next.baseUrl = checkBaseUrl(patch.baseUrl)
    if (patch.models !== undefined) next.models = checkModels(patch.models)
    if (patch.defaultModel !== undefined) next.defaultModel = this.checkDefault(patch.defaultModel)
    if (patch.keyEnv !== undefined) next.keyEnv = this.checkEnv(patch.keyEnv)
    if (next.baseUrl !== record.baseUrl && (await this.secrets?.get(id))) this.keyTransport(next.baseUrl)
    this.col().put(next)
    return this.view(next)
  }

  async setKey(id: string, apiKey: string): Promise<void> {
    const record = this.require(id)
    assertApiKey(apiKey)
    this.requireSecrets()
    this.keyTransport(record.baseUrl)
    await this.secrets!.set(id, apiKey, `Whales: ${record.name}`)
  }

  async clearKey(id: string): Promise<void> {
    this.require(id)
    await this.secrets?.delete(id)
  }

  async delete(id: string): Promise<boolean> {
    const record = this.col().get(id)
    if (!record) return false
    const usedBy = this.usedBy(id)
    if (usedBy.length) throw new Error(`provider ${id} is still used by ${usedBy.map((a) => `agent ${a}`).join(', ')}`)
    await this.secrets?.delete(id)
    return this.col().delete(id)
  }

  async resolveKey(id: string): Promise<string | undefined> {
    const record = this.col().get(id)
    if (!record) return undefined
    const saved = await this.secrets?.get(id)
    if (saved) return saved
    const env = record.keyEnv ? process.env[record.keyEnv] : undefined
    return env ? env : undefined
  }

  async test(id: string): Promise<{ ok: boolean; models: string[]; error?: string }> {
    const record = this.require(id)
    let key: string | undefined
    try {
      key = await this.resolveKey(id)
      if (key) this.keyTransport(record.baseUrl)
      const preset = PROVIDER_PRESETS.find((p) => p.kind === record.kind)
      if (!key && preset?.needsKey) return { ok: false, models: [], error: 'no API key saved for this provider' }
      const headers: Record<string, string> = { accept: 'application/json' }
      if (key) headers.authorization = `Bearer ${key}`
      const res = await fetch(`${record.baseUrl}/models`, { headers, redirect: 'error', signal: AbortSignal.timeout(TEST_TIMEOUT) })
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 300)
        return { ok: false, models: [], error: redact(`HTTP ${res.status}${body ? `: ${body}` : ''}`, key) }
      }
      const data = (await res.json()) as { data?: unknown }
      const models = Array.isArray(data.data)
        ? data.data
            .map((m) => (typeof m === 'object' && m !== null ? (m as { id?: unknown }).id : undefined))
            .filter((m): m is string => typeof m === 'string' && MODEL.test(m))
            .slice(0, MAX_MODELS)
        : []
      return { ok: true, models }
    } catch (err) {
      return { ok: false, models: [], error: redact(message(err), key) }
    }
  }

  // ---- internals ----

  private col() {
    return this.own.store.collection('providers')
  }

  private require(id: string): ProviderRecord {
    const record = this.col().get(id)
    if (!record) throw new Error(`provider ${id} not found`)
    return record
  }

  private requireSecrets(): void {
    if (!this.secrets) throw new Error('no secure key storage on this system (the Keychain is macOS-only); set the provider’s keyEnv variable instead')
  }

  /** Never send a key in clear text off this machine. */
  private keyTransport(baseUrl: string): void {
    const url = new URL(baseUrl)
    if (url.protocol !== 'https:' && !LOOPBACK.has(url.hostname)) throw new TypeError('refusing to use an API key over plain http')
  }

  private checkDefault(model: unknown): string {
    if (typeof model !== 'string' || !MODEL.test(model)) throw new TypeError('defaultModel must be a model id')
    return model
  }

  private checkEnv(name: unknown): string {
    if (typeof name !== 'string' || !ENV_NAME.test(name)) throw new TypeError('keyEnv must be an environment variable NAME like DEEPSEEK_API_KEY')
    return name
  }

  private newId(kind: ProviderKind): string {
    if (!this.col().get(kind)) return kind
    for (let i = 2; ; i++) if (!this.col().get(`${kind}-${i}`)) return `${kind}-${i}`
  }

  private usedBy(id: string): string[] {
    return this.own.store
      .collection('agents')
      .list()
      .filter((r) => r.spec.driver.config?.provider === id)
      .map((r) => r.id)
  }

  private async view(record: ProviderRecord): Promise<ProviderView> {
    let key: ProviderView['key'] = 'none'
    try {
      if (await this.secrets?.get(record.id)) key = 'keychain'
    } catch {
      // Keychain locked or unavailable: fall through to env.
    }
    if (key === 'none' && record.keyEnv && process.env[record.keyEnv]) key = 'env'
    return { ...record, key, usedBy: this.usedBy(record.id) }
  }
}

function redact(text: string, key: string | undefined): string {
  return key ? text.split(key).join('[redacted]') : text
}

export { MemorySecrets }
