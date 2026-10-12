import type { AgentId, RoomId, TurnId } from './core.ts'
import type { DriverEvent } from './driver.ts'
import type { BaseRecord } from './store.ts'

export interface Room extends BaseRecord {
  scope: 'global'
  name: string
  members: AgentId[]
}

/** Scope `room:<id>`. */
export interface RoomMessage extends BaseRecord {
  scope: `room:${RoomId}`
  speaker: AgentId | 'user'
  content: string
  turnId: TurnId
  /** Increments once per `post`. */
  round: number
}

/** Scope `room:<id>`. Shared notes every member sees (prompt section order 300). */
export interface RoomNote extends BaseRecord {
  scope: `room:${RoomId}`
  author: AgentId | 'user'
  text: string
}

export type RoomEvent =
  | { type: 'round-start'; round: number; order: AgentId[] }
  | { type: 'speaker'; agentId: AgentId; position: number; arbiter: boolean }
  | { type: 'agent'; agentId: AgentId; event: DriverEvent }
  | { type: 'message'; message: RoomMessage }
  | { type: 'skipped'; agentId: AgentId; reason: string }
  | { type: 'round-end'; round: number }

export interface TeamProposal extends BaseRecord {
  scope: `agent:${AgentId}`
  leadId: AgentId
  goal: string
  hires: { name: string; role: string; rationale: string }[]
  status: 'proposed' | 'approved' | 'rejected' | 'hired'
}

/**
 * Root `rooms` service (lives in the parent context, not per agent).
 * Turn-taking: members speak one at a time, ascending seniority (ties: join order), so the most
 * senior speaks last. The last speaker gets an arbiter instruction: resolve disagreements and state
 * the room's conclusion. Rounds in one room are serialised; a member that is busy elsewhere is awaited.
 */
export interface RoomsService {
  create(input: { name: string; members: AgentId[] }): Room
  get(id: RoomId): Room | undefined
  list(): Room[]
  addMember(id: RoomId, agentId: AgentId): Room
  removeMember(id: RoomId, agentId: AgentId): Room
  delete(id: RoomId): boolean
  /** Speaking order for the next round; last element is the arbiter. */
  order(id: RoomId): AgentId[]
  /** Post a user message and run one round. */
  post(id: RoomId, content: string, opts?: { signal?: AbortSignal }): AsyncIterable<RoomEvent>
  history(id: RoomId, limit?: number): RoomMessage[]
  addNote(id: RoomId, author: AgentId | 'user', text: string): RoomNote
  notes(id: RoomId): RoomNote[]
  /** Lead drafts a team for a goal (one driver turn, JSON output). Nothing is spawned. */
  proposeTeam(leadId: AgentId, goal: string): Promise<TeamProposal>
  /** Gated by approvals (`agent.hire`). Hires use `config.defaults.cheapDriver`, mode `ask`, `hiredBy=leadId`. */
  hire(proposalId: string, opts?: { signal?: AbortSignal }): Promise<AgentId[]>
}

declare module './store.ts' {
  interface Collections {
    rooms: Room
    roomMessages: RoomMessage
    roomNotes: RoomNote
    teamProposals: TeamProposal
  }
}

declare module 'cordis' {
  interface Context {
    rooms: RoomsService
  }
}
