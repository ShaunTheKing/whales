import type { BaseRecord } from './store.ts'

/**
 * Live web search for agents (built-in `web-search` plugin). One search backend for the whole app, chosen on the
 * Models page. Its API key lives in the macOS Keychain (account `search-<kind>`), never in records.
 */
export type SearchKind = 'brave' | 'tavily' | 'searxng' | 'donsetch'

export interface SearchBackendInfo {
  kind: SearchKind
  label: string
  needsKey: boolean
  /** Only SearXNG takes a URL (your own instance). */
  needsUrl: boolean
  /** Runs a program installed on this Mac (DonSeTch) instead of calling an API. */
  local?: boolean
  keyEnv?: string
  docs: string
}

export interface SearchConfig extends BaseRecord {
  scope: 'global'
  kind: SearchKind
  /** SearXNG instance, e.g. http://127.0.0.1:8888 */
  baseUrl?: string
  /** DonSeTch: absolute path of the `donsetch` program; absent = auto-detect. */
  binaryPath?: string
  /** SearXNG run by Whales in Docker (baseUrl is then the container's local address). */
  managed?: boolean
}

export interface ManagedSearxngStatus {
  state: 'no-docker' | 'docker-stopped' | 'not-created' | 'stopped' | 'starting' | 'running' | 'error'
  url?: string
  image: string
  detail?: string
}

export interface SearchStatus {
  backends: SearchBackendInfo[]
  secretStore: 'keychain' | 'memory' | 'none'
  config?: {
    kind: SearchKind
    baseUrl?: string
    binaryPath?: string
    key: 'keychain' | 'env' | 'none'
    /** DonSeTch: the program that will run, or why none was found. */
    program?: { path?: string; error?: string }
    managed?: boolean
  }
  /** The Whales-managed SearXNG (shown when it is the backend, or when no backend is chosen yet). */
  managed?: ManagedSearxngStatus
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
  /** ISO date or provider-specific age text, when known. */
  published?: string
}

export interface SearchService {
  status(): Promise<SearchStatus>
  configure(input: { kind: SearchKind; baseUrl?: string; apiKey?: string; binaryPath?: string }): Promise<SearchStatus>
  clearKey(): Promise<void>
  /** Remove the backend (and Whales' SearXNG container, if any). With none chosen, search uses managed SearXNG. */
  disable(): Promise<void>
  /** Start (installing on first use) the Whales-managed SearXNG and make it the search backend. */
  useManagedSearxng(): Promise<SearchStatus>
  search(query: string, opts?: { count?: number; signal?: AbortSignal }): Promise<SearchResult[]>
  /** One real query ("Whales test") to check the backend and key. */
  test(): Promise<{ ok: boolean; results: number; error?: string }>
}

declare module './store.ts' {
  interface Collections {
    searchConfig: SearchConfig
  }
}

declare module 'cordis' {
  interface Context {
    search: SearchService
  }
}
