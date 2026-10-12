// Wire types mirrored from the server contracts (src/contracts). Kept separate so the web package has no
// dependency on server code. Only fields the UI uses are listed.

export interface AgentView {
  id: string
  name: string
  role?: string
  seniority: number
  state: 'stopped' | 'starting' | 'active' | 'failed' | 'disposed'
  persisted: boolean
  driver: { name: string; model?: string }
  plugins: string[]
  hiredBy?: string
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
