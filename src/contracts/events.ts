import type { AgentId, RoomId, TurnId } from './core.ts'
import type { AgentHandle } from './agents.ts'
import type { ApprovalRequest } from './approvals.ts'
import type { DriverEvent } from './driver.ts'
import type { RoomEvent } from './rooms.ts'
import type { RoutineRun } from './routines.ts'

export interface TurnInfo {
  agentId: AgentId
  turnId: TurnId
  roomId?: RoomId
  prompt: string
}

/**
 * The app-wide event bus is Cordis's own (`ctx.emit` / `ctx.serial` / `ctx.on`).
 * Listeners registered with `ctx.on` are removed when their plugin disposes.
 * `turn-before` / `turn-after` are dispatched with `ctx.serial` so listeners (checkpoints) can await.
 */
declare module 'cordis' {
  interface Events {
    'whales/agent-spawned'(handle: AgentHandle): void
    'whales/agent-disposed'(agentId: AgentId): void
    'whales/turn-before'(turn: TurnInfo): Promise<void> | void
    'whales/turn-after'(turn: TurnInfo & { ok: boolean; output: string }): Promise<void> | void
    'whales/agent-event'(e: TurnInfo & { event: DriverEvent }): void
    'whales/approval-requested'(req: ApprovalRequest): void
    'whales/approval-resolved'(req: ApprovalRequest): void
    'whales/room-event'(roomId: RoomId, e: RoomEvent): void
    'whales/routine-ran'(run: RoutineRun): void
  }
}
