import type { BaseRecord } from './store.ts'

/**
 * Live web search for agents (built-in `web-search` plugin). One search backend for the whole app, chosen on the
 * Models page. Its API key lives in the macOS Keychain (account `search-<kind>`), never in records.
 */
export type SearchKind = 'brave' | 'tavily' | 'searxng'

export interface SearchBackendInfo {
  kind: SearchKind
  label: string
  needsKey: boolean
  /** Only SearXNG takes a URL (your own instance). */
  needsUrl: boolean
  keyEnv?: string
  docs: string
}

export interface SearchConfig extends BaseRecord {
  scope: 'global'
  kind: SearchKind
  /** SearXNG instance, e.g. http://127.0.0.1:8888 */
  baseUrl?: string
}

export interface SearchStatus {
  backends: SearchBackendInfo[]
  secretStore: 'keychain' | 'memory' | 'none'
  config?: { kind: SearchKind; baseUrl?: string; key: 'keychain' | 'env' | 'none' }
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
  configure(input: { kind: SearchKind; baseUrl?: string; apiKey?: string }): Promise<SearchStatus>
  clearKey(): Promise<void>
  /** Remove the backend: agents' web_search then explains how to set one up. */
  disable(): Promise<void>
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
