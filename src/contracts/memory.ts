import type { AgentId, RoomId, TurnId } from './core.ts'
import type { BaseRecord } from './store.ts'

/** Scope `agent:<id>`: notes follow the agent across DMs and rooms. */
export interface MemoryNote extends BaseRecord {
  scope: `agent:${AgentId}`
  text: string
  tags: string[]
  source?: { roomId?: RoomId; turnId?: TurnId }
  lastUsedAt?: number
}

export interface ScoredNote {
  note: MemoryNote
  /** 0..1, higher is more relevant. */
  score: number
}

/**
 * Per-agent `memory` service (provided by the `memory` plugin inside the agent context).
 * The plugin also registers a PromptSection (order 200) that injects `recall(prompt)` results
 * and a `remember` tool (no approval needed: it only touches the agent's own notes).
 */
export interface MemoryService {
  remember(text: string, opts?: { tags?: string[]; source?: MemoryNote['source'] }): MemoryNote
  /** Lexical relevance (BM25 over text + tags), recency tiebreak. Updates lastUsedAt of returned notes. */
  recall(query: string, limit?: number): ScoredNote[]
  list(): MemoryNote[]
  forget(id: string): boolean
}

declare module './store.ts' {
  interface Collections {
    memories: MemoryNote
  }
}

declare module 'cordis' {
  interface Context {
    memory: MemoryService
  }
}
