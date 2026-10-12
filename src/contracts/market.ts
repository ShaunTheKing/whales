import type { BaseRecord } from './store.ts'

/**
 * Plugin marketplace. Plugins are third-party code that runs IN-PROCESS with full Node access once the user approves
 * the install (user decision, Phase 6). The safety properties are about knowing exactly what runs:
 *   - index entries pin a GitHub repo to a full commit hash; git verifies the content against it;
 *   - the bytes previewed are the bytes installed (staged once, moved into place, digest re-checked);
 *   - installs/uninstalls are user actions only (HTTP API / CLI), never agent tools;
 *   - no install scripts run and no dependencies are fetched: a plugin is a self-contained folder.
 */

/** `whales-plugin.json` at the plugin's root. */
export interface PluginManifest {
  /** `^[a-z][a-z0-9-]{1,48}$`; becomes the catalog name. Must not clash with a built-in. */
  name: string
  version: string
  description: string
  /** Relative path of the module to import (.js, .mjs or .ts), inside the plugin folder. */
  entry: string
  author?: string
  license?: string
  homepage?: string
  /** Where the plugin makes sense. Default both. */
  scopes?: ('agent' | 'room')[]
}

/** One entry of a marketplace index file. */
export interface IndexEntry {
  name: string
  version: string
  description: string
  /** `https://github.com/<owner>/<repo>` */
  repo: string
  /** Full 40-hex commit sha the install is pinned to. */
  commit: string
  /** Sub-directory of the repo holding `whales-plugin.json`. Default: repo root. */
  path?: string
  author?: string
  license?: string
  homepage?: string
  tags?: string[]
  scopes?: ('agent' | 'room')[]
}

/** A marketplace index file (JSON over https, e.g. raw.githubusercontent.com). */
export interface MarketIndex {
  version: 1
  name: string
  plugins: IndexEntry[]
}

export interface MarketSource extends BaseRecord {
  scope: 'global'
  /** https URL of an index file. */
  url: string
}

export interface BrowseResult {
  source: string
  name?: string
  entries: IndexEntry[]
  error?: string
}

export interface PluginFile {
  path: string
  bytes: number
}

/** A staged, not yet installed plugin. Expires after 30 minutes. */
export interface InstallPreview {
  id: string
  manifest: PluginManifest
  origin: { kind: 'github'; repo: string; commit: string; path?: string; index?: string } | { kind: 'local'; path: string }
  files: PluginFile[]
  totalBytes: number
  /** sha256 over the sorted (path, content) list; shown to the user and re-checked at install. */
  digest: string
  /** Things the user should read before approving (e.g. "has a package.json with dependencies: they will NOT be installed"). */
  warnings: string[]
  expiresAt: number
}

export interface InstalledPlugin extends BaseRecord {
  scope: 'global'
  /** = manifest.name (record id too). */
  name: string
  manifest: PluginManifest
  origin: InstallPreview['origin']
  digest: string
  /** Absolute folder the plugin was installed into. */
  dir: string
  /** Load state in this process. */
}

export interface InstalledView extends InstalledPlugin {
  state: 'loaded' | 'failed' | 'pending-restart'
  error?: string
  /** Agents and rooms whose specs reference this plugin. */
  usedBy: { agents: string[]; rooms: string[] }
}

export interface CatalogEntry {
  name: string
  kind: 'builtin' | 'market'
  description?: string
  version?: string
  scopes: ('agent' | 'room')[]
}

export interface MarketService {
  sources(): MarketSource[]
  addSource(url: string): MarketSource
  removeSource(id: string): boolean
  /** Fetch every source's index. Never throws: a failing source is reported in `error`. */
  browse(): Promise<BrowseResult[]>
  /** Download (git, pinned) or copy (local folder) into staging and describe it. Nothing is loaded. */
  preview(input: { source: string; name: string } | { repo: string; commit: string; path?: string } | { local: string }): Promise<InstallPreview>
  /** Install a staged preview and load it into the catalog. `digest` must match the preview's. */
  install(previewId: string, digest: string): Promise<InstalledView>
  /** Refuses while an agent or room still uses it. The module stays in memory until restart (ESM cannot unload). */
  uninstall(name: string): Promise<boolean>
  list(): InstalledView[]
  /** Built-in + installed plugins usable in agent/room plugin lists. */
  catalog(): CatalogEntry[]
}

declare module './store.ts' {
  interface Collections {
    marketSources: MarketSource
    plugins: InstalledPlugin
  }
}

declare module 'cordis' {
  interface Context {
    market: MarketService
  }
}
