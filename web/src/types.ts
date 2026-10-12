// Wire types mirrored from the server contracts (src/contracts). Kept separate so the web package has no
// dependency on server code. Only fields the UI uses are listed.

export interface AgentView {
  id: string
  name: string
  role?: string
  seniority: number
  state: 'stopped' | 'starting' | 'active' | 'failed' | 'disposed'
  persisted: boolean
  driver: { name: string; model?: string; provider?: string }
  plugins: string[]
  hiredBy?: string
  /** Latest DM message (clipped), for the conversation list. */
  last?: { text: string; at: number; from: 'user' | 'assistant' }
}

export interface PluginRef {
  name: string
  config?: Record<string, unknown>
}

export interface AgentSpec {
  id: string
  name: string
  role?: string
  instructions?: string
  seniority: number
  driver: PluginRef
  plugins: PluginRef[]
  rules?: string[]
  permissionMode?: 'ask' | 'strict' | 'trusted'
  hiredBy?: string
}

export type StopReason = 'end' | 'max_tokens' | 'cancelled' | 'refused' | 'error'

export type DriverEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | { type: 'waiting_approval'; requestId: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
  | { type: 'done'; stopReason: StopReason }

export interface DmMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  turnId: string
}

export interface Room {
  id: string
  name: string
  members: string[]
  createdAt: number
  plugins?: PluginRef[]
  /** Latest room message (clipped); `from` is an agent id or 'user'. Only on GET /rooms. */
  last?: { text: string; at: number; from: string }
}

export interface RoomMessage {
  id: string
  speaker: string // agent id or 'user'
  content: string
  round: number
  createdAt: number
}

export interface RoomNote {
  id: string
  author: string
  text: string
  createdAt: number
}

export type RoomEvent =
  | { type: 'round-start'; round: number; order: string[] }
  | { type: 'speaker'; agentId: string; position: number; arbiter: boolean }
  | { type: 'agent'; agentId: string; event: DriverEvent }
  | { type: 'message'; message: RoomMessage }
  | { type: 'skipped'; agentId: string; reason: string }
  | { type: 'round-end'; round: number }

export type ActionKind = 'file.read' | 'file.write' | 'shell' | 'network' | 'tool' | 'message' | 'skill.install' | 'agent.hire'

export interface ApprovalRequest {
  id: string
  createdAt: number
  action: { kind: ActionKind; target: string; agentId: string; roomId?: string; summary: string; detail?: unknown }
  reason: string
  status: 'pending' | 'allowed' | 'denied' | 'expired' | 'cancelled'
}

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny'

export interface Checkpoint {
  id: string
  agentId: string
  phase: 'before' | 'after' | 'manual'
  label: string
  ref: string
  createdAt: number
  turnId?: string
}

export interface FileChange {
  path: string
  status: 'added' | 'modified' | 'deleted'
}

/** Frames on the /api/events WebSocket. */
export type ServerEvent =
  | { type: 'ready'; data: { agents: { id: string; name: string; state: string }[] } }
  | { type: 'agent-spawned'; data: { id: string; name: string; state: string } }
  | { type: 'agent-disposed'; data: { agentId: string } }
  | { type: 'agent-event'; data: { agentId: string; turnId: string; roomId?: string; event: DriverEvent } }
  | { type: 'approval-requested'; data: ApprovalRequest }
  | { type: 'approval-resolved'; data: ApprovalRequest }
  | { type: 'room-event'; data: { roomId: string; event: RoomEvent } }
  | { type: 'turn-before' | 'turn-after' | 'routine-ran'; data: unknown }

// ---- plugins & marketplace (mirrors src/contracts/market.ts) ----

export interface PluginManifest {
  name: string
  version: string
  description: string
  entry: string
  author?: string
  license?: string
  homepage?: string
  scopes?: ('agent' | 'room')[]
}

export interface IndexEntry {
  name: string
  version: string
  description: string
  repo: string
  commit: string
  path?: string
  author?: string
  license?: string
  homepage?: string
  tags?: string[]
  scopes?: ('agent' | 'room')[]
}

export interface MarketSource {
  id: string
  url: string
  createdAt: number
}

export interface BrowseResult {
  source: string
  name?: string
  entries: IndexEntry[]
  error?: string
}

export type PluginOrigin =
  | { kind: 'github'; repo: string; commit: string; path?: string; index?: string }
  | { kind: 'local'; path: string }

export interface InstallPreview {
  id: string
  manifest: PluginManifest
  origin: PluginOrigin
  files: { path: string; bytes: number }[]
  totalBytes: number
  digest: string
  warnings: string[]
  expiresAt: number
}

export interface InstalledPlugin {
  name: string
  manifest: PluginManifest
  origin: PluginOrigin
  digest: string
  dir: string
  createdAt: number
  state: 'loaded' | 'failed' | 'pending-restart'
  error?: string
  usedBy: { agents: string[]; rooms: string[] }
}

export interface CatalogEntry {
  name: string
  kind: 'builtin' | 'market'
  description?: string
  version?: string
  scopes: ('agent' | 'room')[]
}

export interface RoomPluginStatus {
  roomId: string
  agentId: string
  plugin: string
  state: 'active' | 'failed'
  error?: string
}

// ---- model providers (mirrors src/contracts/providers.ts). Keys are never part of these types. ----

export type ProviderKind = 'deepseek' | 'openai' | 'opencode' | 'opencode-go' | 'openrouter' | 'ollama' | 'custom'

export interface ProviderPreset {
  kind: ProviderKind
  label: string
  baseUrl: string
  keyEnv?: string
  needsKey: boolean
  models: string[]
  docs?: string
}

export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  models: string[]
  defaultModel?: string
  keyEnv?: string
  createdAt: number
  /** Where the key comes from right now. */
  key: 'keychain' | 'env' | 'none'
  usedBy: string[]
}

export interface ProvidersResponse {
  /** 'keychain' on macOS; 'none' means keys cannot be saved (use an environment variable instead). */
  secretStore: 'keychain' | 'memory' | 'none'
  presets: ProviderPreset[]
  providers: Provider[]
}

export interface ProviderInput {
  kind: ProviderKind
  name?: string
  baseUrl?: string
  models?: string[]
  defaultModel?: string
  keyEnv?: string
  apiKey?: string
}

// ---- web search (mirrors src/contracts/search.ts). Keys are write-only. ----

export type SearchKind = 'brave' | 'tavily' | 'searxng' | 'donsetch'

export interface SearchBackendInfo {
  kind: SearchKind
  label: string
  needsKey: boolean
  needsUrl: boolean
  /** Runs a program installed on this Mac (DonSeTch). */
  local?: boolean
  keyEnv?: string
  docs: string
}

export interface SearchStatus {
  backends: SearchBackendInfo[]
  secretStore: 'keychain' | 'memory' | 'none'
  config?: {
    kind: SearchKind
    baseUrl?: string
    binaryPath?: string
    key: 'keychain' | 'env' | 'none'
    program?: { path?: string; error?: string }
  }
}
