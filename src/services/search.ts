import { Service, type Context } from 'cordis'
import type { SearchBackendInfo, SearchConfig, SearchKind, SearchResult, SearchService, SearchStatus } from '../contracts/search.ts'
import { MacKeychain, assertApiKey, type SecretStore } from '../core/keychain.ts'

/**
 * SECURITY (orchestrator-owned). The search backend. The query is the only agent-controlled input; the endpoint is
 * fixed per backend (Brave, Tavily) or chosen by the user (SearXNG). Keys come from the Keychain (or an env var) at call
 * time and are redacted from every error.
 */

export interface SearchServiceConfig {
  /** Default: the macOS Keychain on darwin. Tests pass a MemorySecrets. */
  secrets?: SecretStore | false
  /** Tests only: override the fixed endpoints. */
  endpoints?: Partial<Record<'brave' | 'tavily', string>>
}

export const SEARCH_BACKENDS: SearchBackendInfo[] = [
  { kind: 'brave', label: 'Brave Search', needsKey: true, needsUrl: false, keyEnv: 'BRAVE_SEARCH_API_KEY', docs: 'https://brave.com/search/api/' },
  { kind: 'tavily', label: 'Tavily', needsKey: true, needsUrl: false, keyEnv: 'TAVILY_API_KEY', docs: 'https://tavily.com' },
  { kind: 'searxng', label: 'SearXNG (self-hosted, free)', needsKey: false, needsUrl: true, docs: 'https://docs.searxng.org' },
]

const CONFIG_ID = 'search'
const MAX_QUERY = 400
const MAX_RESULTS = 10
const TIMEOUT = 15_000

const ENDPOINTS = {
  brave: 'https://api.search.brave.com/res/v1/web/search',
  tavily: 'https://api.tavily.com/search',
}

function account(kind: SearchKind): string {
  return `search-${kind}`
}

function clean(text: unknown, max: number): string {
  if (typeof text !== 'string') return ''
  const flat = text
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function result(title: unknown, url: unknown, snippet: unknown, published?: unknown): SearchResult | undefined {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return undefined
  const r: SearchResult = { title: clean(title, 200) || url, url: url.slice(0, 2000), snippet: clean(snippet, 600) }
  const date = clean(published, 40)
  if (date) r.published = date
  return r
}

function checkUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) throw new TypeError('SearXNG needs the URL of your instance, e.g. http://127.0.0.1:8888')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new TypeError('SearXNG URL is not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('SearXNG URL must be http or https')
  if (url.username || url.password || url.search || url.hash) throw new TypeError('SearXNG URL must not contain credentials, a query or a fragment')
  return url.href.replace(/\/+$/, '')
}

export class Search extends Service implements SearchService {
  static inject = ['store']

  private own: Context
  private secrets: SecretStore | undefined
  private endpoints: typeof ENDPOINTS

  constructor(ctx: Context, config: SearchServiceConfig = {}) {
    super(ctx, 'search')
    this.own = ctx
    this.secrets = config.secrets === false ? undefined : (config.secrets ?? (process.platform === 'darwin' ? new MacKeychain() : undefined))
    this.endpoints = { ...ENDPOINTS, ...config.endpoints }
  }

  async status(): Promise<SearchStatus> {
    const status: SearchStatus = { backends: SEARCH_BACKENDS.map((b) => ({ ...b })), secretStore: this.secrets?.kind ?? 'none' }
    const config = this.config()
    if (config) {
      let key: 'keychain' | 'env' | 'none' = 'none'
      try {
        if (await this.secrets?.get(account(config.kind))) key = 'keychain'
      } catch {
        // Keychain locked: fall through to env.
      }
      const env = SEARCH_BACKENDS.find((b) => b.kind === config.kind)?.keyEnv
      if (key === 'none' && env && process.env[env]) key = 'env'
      status.config = { kind: config.kind, key, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}) }
    }
    return status
  }

  async configure(input: { kind: SearchKind; baseUrl?: string; apiKey?: string }): Promise<SearchStatus> {
    const backend = SEARCH_BACKENDS.find((b) => b.kind === input?.kind)
    if (!backend) throw new TypeError('search backend must be one of brave, tavily, searxng')
    const record: SearchConfig = { id: CONFIG_ID, scope: 'global', createdAt: Date.now(), kind: backend.kind }
    if (backend.needsUrl) record.baseUrl = checkUrl(input.baseUrl)
    if (input.apiKey !== undefined && input.apiKey !== '') {
      assertApiKey(input.apiKey)
      if (!this.secrets) throw new Error('no secure key storage on this system (the Keychain is macOS-only); set the backend’s environment variable instead')
      await this.secrets.set(account(backend.kind), input.apiKey, `Whales: ${backend.label}`)
    }
    this.own.store.collection('searchConfig').put(record)
    return this.status()
  }

  async clearKey(): Promise<void> {
    const config = this.config()
    if (config) await this.secrets?.delete(account(config.kind))
  }

  async disable(): Promise<void> {
    const config = this.config()
    if (config) await this.secrets?.delete(account(config.kind))
    this.own.store.collection('searchConfig').delete(CONFIG_ID)
  }

  async search(query: string, opts: { count?: number; signal?: AbortSignal } = {}): Promise<SearchResult[]> {
    if (typeof query !== 'string' || !query.trim()) throw new TypeError('query must be a non-empty string')
    const q = query.trim().slice(0, MAX_QUERY)
    const count = Math.min(Math.max(Math.trunc(opts.count ?? 5), 1), MAX_RESULTS)
    const config = this.config()
    if (!config) throw new Error('web search is not set up yet: open Models → Web search in Whales and choose Brave, Tavily or SearXNG')
    const key = await this.key(config.kind)
    const backend = SEARCH_BACKENDS.find((b) => b.kind === config.kind)!
    if (backend.needsKey && !key) throw new Error(`no API key saved for ${backend.label} (Models → Web search)`)
    const signal = AbortSignal.any([opts.signal ?? new AbortController().signal, AbortSignal.timeout(TIMEOUT)])
    try {
      switch (config.kind) {
        case 'brave':
          return await this.brave(q, count, key!, signal)
        case 'tavily':
          return await this.tavily(q, count, key!, signal)
        case 'searxng':
          return await this.searxng(q, count, config.baseUrl!, key, signal)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(key ? message.split(key).join('[redacted]') : message)
    }
  }

  async test(): Promise<{ ok: boolean; results: number; error?: string }> {
    try {
      const results = await this.search('Whales test', { count: 3 })
      return { ok: true, results: results.length }
    } catch (err) {
      return { ok: false, results: 0, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ---- backends ----

  private async brave(q: string, count: number, key: string, signal: AbortSignal): Promise<SearchResult[]> {
    const url = new URL(this.endpoints.brave)
    url.searchParams.set('q', q)
    url.searchParams.set('count', String(count))
    const data = await this.json(url.href, { headers: { accept: 'application/json', 'x-subscription-token': key }, signal })
    const items = (data as { web?: { results?: unknown[] } }).web?.results ?? []
    return items
      .map((r) => {
        const x = r as Record<string, unknown>
        return result(x.title, x.url, x.description, x.page_age ?? x.age)
      })
      .filter((r): r is SearchResult => r !== undefined)
      .slice(0, count)
  }

  private async tavily(q: string, count: number, key: string, signal: AbortSignal): Promise<SearchResult[]> {
    const data = await this.json(this.endpoints.tavily, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: q, max_results: count, search_depth: 'basic' }),
      signal,
    })
    const items = (data as { results?: unknown[] }).results ?? []
    return items
      .map((r) => {
        const x = r as Record<string, unknown>
        return result(x.title, x.url, x.content, x.published_date)
      })
      .filter((r): r is SearchResult => r !== undefined)
      .slice(0, count)
  }

  private async searxng(q: string, count: number, baseUrl: string, key: string | undefined, signal: AbortSignal): Promise<SearchResult[]> {
    const url = new URL(`${baseUrl}/search`)
    url.searchParams.set('q', q)
    url.searchParams.set('format', 'json')
    const headers: Record<string, string> = { accept: 'application/json' }
    if (key) headers.authorization = `Bearer ${key}`
    const data = await this.json(url.href, { headers, signal })
    const items = (data as { results?: unknown[] }).results ?? []
    return items
      .map((r) => {
        const x = r as Record<string, unknown>
        return result(x.title, x.url, x.content, x.publishedDate)
      })
      .filter((r): r is SearchResult => r !== undefined)
      .slice(0, count)
  }

  private async json(url: string, init: RequestInit & { signal: AbortSignal }): Promise<unknown> {
    const res = await fetch(url, { ...init, redirect: 'error' })
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300)
      const hint = res.status === 401 || res.status === 403 ? ' (check the API key)' : res.status === 429 ? ' (rate limit or quota reached)' : ''
      throw new Error(`search failed: HTTP ${res.status}${hint}${body ? `: ${clean(body, 300)}` : ''}`)
    }
    try {
      return await res.json()
    } catch {
      throw new Error('search failed: the backend did not return JSON (for SearXNG, enable the json format in settings.yml)')
    }
  }

  private config(): SearchConfig | undefined {
    return this.own.store.collection('searchConfig').get(CONFIG_ID)
  }

  private async key(kind: SearchKind): Promise<string | undefined> {
    const saved = await this.secrets?.get(account(kind)).catch(() => undefined)
    if (saved) return saved
    const env = SEARCH_BACKENDS.find((b) => b.kind === kind)?.keyEnv
    return env && process.env[env] ? process.env[env] : undefined
  }
}

/** Format results for the model: numbered, with URLs, so it can cite and open them. */
export function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No results for "${query}".`
  const lines = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}${r.published ? ` · ${r.published}` : ''}\n${r.snippet}`)
  return `Results for "${query}" (searched ${new Date().toISOString().slice(0, 10)}):\n\n${lines.join('\n\n')}\n\nCite sources as [n] with their URLs. Use web_open to read a page in full.`
}
