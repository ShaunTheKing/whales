import type { AgentId } from './core.ts'
import type { BaseRecord } from './store.ts'

export interface AllowedWindow {
  /** `HH:MM`, 24h, local to `tz`. If end < start the window wraps midnight. */
  start: string
  end: string
  /** 0 = Sunday. Omitted = every day. */
  days?: number[]
  /** IANA zone. Omitted = system zone. */
  tz?: string
}

export interface Routine extends BaseRecord {
  scope: `agent:${AgentId}`
  agentId: AgentId
  prompt: string
  /** Minimum 5. */
  everyMinutes: number
  window?: AllowedWindow
  /** Quiet: a reply of exactly `NOTHING` (case-insensitive, trimmed) or empty is not surfaced. */
  quiet: boolean
  enabled: boolean
  lastRunAt?: number
}

export interface RoutineRun {
  routineId: string
  agentId: AgentId
  startedAt: number
  finishedAt: number
  output: string
  /** True when quiet and nothing to report, or the run was outside the window. */
  silent: boolean
  error?: string
}

/**
 * Root `routines` service. Timers are created with `ctx.effect` so disposing the service (or the
 * agent: routines for a disposed agent are skipped) leaves nothing running. Never overlaps runs of
 * one routine; skips a tick if the agent is busy.
 */
export interface RoutinesService {
  add(input: Omit<Routine, 'id' | 'scope' | 'createdAt' | 'lastRunAt'>): Routine
  update(id: string, patch: Partial<Pick<Routine, 'prompt' | 'everyMinutes' | 'window' | 'quiet' | 'enabled'>>): Routine
  remove(id: string): boolean
  list(agentId?: AgentId): Routine[]
  /** Ignores the window. */
  runNow(id: string): Promise<RoutineRun>
  /** Pure helper, exported for tests. */
  inWindow(window: AllowedWindow | undefined, at: Date): boolean
}

declare module './store.ts' {
  interface Collections {
    routines: Routine
  }
}

declare module 'cordis' {
  interface Context {
    routines: RoutinesService
  }
}
