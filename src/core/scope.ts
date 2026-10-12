import type { Context } from 'cordis'
import type { RoomId } from '../contracts/core.ts'

/**
 * Marks a context branch as room-scoped (set by the room plugin loader via `ctx.extend({ [ROOM_SCOPE]: roomId })`).
 * A symbol key, because Cordis's context proxy refuses unknown string properties without `inject`.
 * Tools and prompt sections registered from such a branch are only offered during that room's turns.
 */
export const ROOM_SCOPE: unique symbol = Symbol.for('whales.roomScope')

export function roomScopeOf(ctx: Context): RoomId | undefined {
  const value = (ctx as unknown as Record<symbol, unknown>)[ROOM_SCOPE]
  return typeof value === 'string' ? value : undefined
}
