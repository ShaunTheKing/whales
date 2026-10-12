import type { BaseRecord } from './store.ts'

/**
 * Model providers the user configured in the UI (Models page). A provider holds a base URL and a model list; its API
 * key lives in the macOS Keychain (account = provider id) or, for headless setups, in an environment variable named by
 * `keyEnv`. Records never contain a key. Agents reference a provider with
 * `driver: { name: 'driver-openai-compat', config: { provider: '<id>', model: '…' } }`.
 */
export type ProviderKind = 'deepseek' | 'openai' | 'opencode' | 'opencode-go' | 'openrouter' | 'ollama' | 'custom'

export interface ProviderPreset {
  kind: ProviderKind
  label: string
  baseUrl: string
  /** Env var checked when no Keychain key is saved. */
  keyEnv?: string
  needsKey: boolean
  /** Suggestions; `test()` fetches the provider's real list. */
  models: string[]
  docs?: string
}

export interface ProviderRecord extends BaseRecord {
  scope: 'global'
  name: string
  kind: ProviderKind
  baseUrl: string
  models: string[]
  defaultModel?: string
  /** Env var fallback for the key (name only). */
  keyEnv?: string
}

export interface ProviderView extends ProviderRecord {
  /** Where the key currently comes from. */
  key: 'keychain' | 'env' | 'none'
  /** Agents whose driver uses this provider. */
  usedBy: string[]
}

export interface ProviderInput {
  kind: ProviderKind
  name?: string
  baseUrl?: string
  models?: string[]
  defaultModel?: string
  keyEnv?: string
  /** Saved straight to the Keychain; never stored or returned. */
  apiKey?: string
}

export interface ProvidersService {
  readonly secretStore: 'keychain' | 'memory' | 'none'
  presets(): ProviderPreset[]
  list(): Promise<ProviderView[]>
  get(id: string): ProviderRecord | undefined
  create(input: ProviderInput): Promise<ProviderView>
  update(id: string, patch: Partial<Pick<ProviderRecord, 'name' | 'baseUrl' | 'models' | 'defaultModel' | 'keyEnv'>>): Promise<ProviderView>
  setKey(id: string, apiKey: string): Promise<void>
  clearKey(id: string): Promise<void>
  /** Refuses while an agent uses it. Also removes its Keychain item. */
  delete(id: string): Promise<boolean>
  /** For drivers only. */
  resolveKey(id: string): Promise<string | undefined>
  /** GET <baseUrl>/models with the key: proves the key works and returns the model ids. */
  test(id: string): Promise<{ ok: boolean; models: string[]; error?: string }>
}

declare module './store.ts' {
  interface Collections {
    providers: ProviderRecord
  }
}

declare module 'cordis' {
  interface Context {
    providers: ProvidersService
  }
}
