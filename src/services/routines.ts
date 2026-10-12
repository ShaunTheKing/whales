import { Service, type Context } from 'cordis'
import { isAgentId, newId } from '../core/ids.ts'
import type { AgentId } from '../contracts/core.ts'
import type { DriverEvent } from '../contracts/driver.ts'
import type { AllowedWindow, Routine, RoutineRun, RoutinesService } from '../contracts/routines.ts'
import type {} from '../contracts/agents.ts'
import type {} from '../contracts/store.ts'

export interface RoutinesConfig {
  /** Scheduler tick, ms. Default 60000. Tests use small values. Finite > 0. */
  tickMs?: number
  /** Clock, for tests. Default () => Date.now(). */
  now?: () => number
}

export const QUIET_SUFFIX = '\n\nIf there is nothing worth reporting, reply with exactly NOTHING.'

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type AddInput = Omit<Routine, 'id' | 'scope' | 'createdAt' | 'lastRunAt'>
type UpdatePatch = Partial<Pick<Routine, 'prompt' | 'everyMinutes' | 'window' | 'quiet' | 'enabled'>>

function assertPrompt(prompt: unknown): asserts prompt is string {
  if (typeof prompt !== 'string' || prompt.trim().length < 1 || prompt.trim().length > 4000) {
    throw new TypeError('prompt must be a string of 1..4000 characters')
  }
}

function assertEveryMinutes(everyMinutes: unknown): asserts everyMinutes is number {
  if (
    typeof everyMinutes !== 'number' ||
    !Number.isInteger(everyMinutes) ||
    everyMinutes < 5 ||
    everyMinutes > 10080
  ) {
    throw new TypeError('everyMinutes must be an integer between 5 and 10080')
  }
}

function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${field} must be a boolean`)
  }
}

function assertWindow(window: unknown): asserts window is AllowedWindow {
  if (typeof window !== 'object' || window === null) {
    throw new TypeError('window must be an object')
  }
  const w = window as AllowedWindow
  if (typeof w.start !== 'string' || !HHMM_RE.test(w.start)) {
    throw new TypeError('window.start must match HH:MM')
  }
  if (typeof w.end !== 'string' || !HHMM_RE.test(w.end)) {
    throw new TypeError('window.end must match HH:MM')
  }
  if (w.days !== undefined) {
    if (!Array.isArray(w.days) || w.days.length === 0) {
      throw new TypeError('window.days must be a non-empty array')
    }
    const seen = new Set<number>()
    for (const day of w.days) {
      if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) {
        throw new TypeError('window.days must contain integers 0..6')
      }
      if (seen.has(day)) {
        throw new TypeError('window.days must not contain duplicates')
      }
      seen.add(day)
    }
  }
  if (w.tz !== undefined) {
    if (typeof w.tz !== 'string') {
      throw new TypeError('window.tz must be a string')
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: w.tz })
    } catch {
      throw new TypeError(`window.tz is not a valid time zone: ${w.tz}`)
    }
  }
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}

export class Routines extends Service implements RoutinesService {
  static inject = ['store', 'agents']

  private readonly store: Context['store']
  private readonly agents: Context['agents']
  private readonly own: Context
  private readonly now: () => number
  private readonly tickMs: number
  private readonly inFlight = new Set<string>()

  constructor(ctx: Context, config?: RoutinesConfig) {
    super(ctx, 'routines')
    this.store = ctx.store
    this.agents = ctx.agents
    this.own = ctx
    const tickMs = config?.tickMs ?? 60000
    if (typeof tickMs !== 'number' || !Number.isFinite(tickMs) || tickMs <= 0) {
      throw new TypeError('tickMs must be a finite number greater than 0')
    }
    this.tickMs = tickMs
    this.now = config?.now ?? (() => Date.now())
    ctx.effect(() => {
      const t = setInterval(() => this.tick(), this.tickMs)
      return () => clearInterval(t)
    })
  }

  add(input: AddInput): Routine {
    if (!isAgentId(input.agentId)) {
      throw new TypeError(`agentId is not a valid agent id: ${JSON.stringify(input.agentId)}`)
    }
    assertPrompt(input.prompt)
    assertEveryMinutes(input.everyMinutes)
    assertBoolean(input.quiet, 'quiet')
    assertBoolean(input.enabled, 'enabled')
    if (input.window !== undefined) {
      assertWindow(input.window)
    }
    const routine: Routine = {
      id: newId('rtn'),
      scope: `agent:${input.agentId}`,
      agentId: input.agentId,
      prompt: input.prompt,
      everyMinutes: input.everyMinutes,
      quiet: input.quiet,
      enabled: input.enabled,
      createdAt: this.now(),
    }
    if (input.window !== undefined) {
      routine.window = input.window
    }
    this.store.collection('routines').put(routine)
    return routine
  }

  update(id: string, patch: UpdatePatch): Routine {
    const existing = this.store.collection('routines').get(id)
    if (!existing) {
      throw new Error(`routine ${id} not found`)
    }
    if (patch.prompt !== undefined) {
      assertPrompt(patch.prompt)
    }
    if (patch.everyMinutes !== undefined) {
      assertEveryMinutes(patch.everyMinutes)
    }
    if (patch.quiet !== undefined) {
      assertBoolean(patch.quiet, 'quiet')
    }
    if (patch.enabled !== undefined) {
      assertBoolean(patch.enabled, 'enabled')
    }
    if (patch.window !== undefined) {
      assertWindow(patch.window)
    }
    const next: Routine = { ...existing }
    if (patch.prompt !== undefined) {
      next.prompt = patch.prompt
    }
    if (patch.everyMinutes !== undefined) {
      next.everyMinutes = patch.everyMinutes
    }
    if (patch.quiet !== undefined) {
      next.quiet = patch.quiet
    }
    if (patch.enabled !== undefined) {
      next.enabled = patch.enabled
    }
    if (patch.window !== undefined) {
      next.window = patch.window
    }
    this.store.collection('routines').put(next)
    return next
  }

  remove(id: string): boolean {
    return this.store.collection('routines').delete(id)
  }

  list(agentId?: AgentId): Routine[] {
    const routines = this.store.collection('routines')
    return agentId === undefined ? routines.list() : routines.list({ scope: `agent:${agentId}` })
  }

  inWindow(window: AllowedWindow | undefined, at: Date): boolean {
    if (window === undefined) {
      return true
    }
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: window.tz,
      hour12: false,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(at)
    let weekday = -1
    let hour = 0
    let minute = 0
    for (const part of parts) {
      if (part.type === 'weekday') {
        weekday = WEEKDAYS.indexOf(part.value)
      } else if (part.type === 'hour') {
        hour = Number(part.value) % 24
      } else if (part.type === 'minute') {
        minute = Number(part.value)
      }
    }
    if (window.days !== undefined && !window.days.includes(weekday)) {
      return false
    }
    const start = minutesOf(window.start)
    const end = minutesOf(window.end)
    const m = hour * 60 + minute
    if (start === end) {
      return true
    }
    if (end > start) {
      return m >= start && m < end
    }
    return m >= start || m < end
  }

  async runNow(id: string): Promise<RoutineRun> {
    const routine = this.store.collection('routines').get(id)
    if (!routine) {
      throw new Error(`routine ${id} not found`)
    }
    const handle = this.agents.get(routine.agentId)
    if (!handle || handle.state !== 'active' || !handle.runtime) {
      throw new Error(`agent ${routine.agentId} is not active`)
    }
    if (this.inFlight.has(routine.id)) {
      throw new Error(`routine ${routine.id} is already running`)
    }
    this.inFlight.add(routine.id)
    try {
      return await this.execute(routine)
    } finally {
      this.inFlight.delete(routine.id)
    }
  }

  private tick(): void {
    let routines: Routine[]
    try {
      routines = this.list()
    } catch (err) {
      this.own.logger('routines').warn(`tick failed to list routines: ${String(err)}`)
      return
    }
    const at = new Date(this.now())
    for (const routine of routines) {
      try {
        if (!routine.enabled) continue
        if (this.inFlight.has(routine.id)) continue
        const due = this.now() >= (routine.lastRunAt ?? routine.createdAt) + routine.everyMinutes * 60000
        if (!due) continue
        const handle = this.agents.get(routine.agentId)
        if (!handle || handle.state !== 'active' || !handle.runtime) continue
        if (handle.runtime.busy) continue
        if (!this.inWindow(routine.window, at)) continue
        this.inFlight.add(routine.id)
        void this.execute(routine)
          .catch((err: unknown) => {
            this.own.logger('routines').warn(`routine ${routine.id} failed: ${String(err)}`)
          })
          .finally(() => {
            this.inFlight.delete(routine.id)
          })
      } catch (err) {
        this.own.logger('routines').warn(`routine ${routine.id} tick error: ${String(err)}`)
      }
    }
  }

  private async execute(routine: Routine): Promise<RoutineRun> {
    const startedAt = this.now()
    const updated: Routine = { ...routine, lastRunAt: startedAt }
    this.store.collection('routines').put(updated)

    const prompt = routine.prompt + (routine.quiet ? QUIET_SUFFIX : '')
    let output = ''
    let error: string | undefined
    let stopReason: string | undefined

    const handle = this.agents.get(routine.agentId)
    if (!handle || handle.state !== 'active' || !handle.runtime) {
      error = `agent ${routine.agentId} is not active`
    } else {
      try {
        for await (const event of handle.runtime.turn(prompt)) {
          if (event.type === 'text') {
            output += event.delta
          } else if (event.type === 'error') {
            error = event.message
          } else if (event.type === 'done') {
            stopReason = event.stopReason
          }
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
    }

    if (error === undefined && stopReason !== undefined && stopReason !== 'end') {
      error = `stopped: ${stopReason}`
    }

    const trimmed = output.trim()
    const silent =
      routine.quiet && error === undefined && (trimmed === '' || trimmed.toUpperCase() === 'NOTHING')

    const finishedAt = this.now()
    const run: RoutineRun = {
      routineId: routine.id,
      agentId: routine.agentId,
      startedAt,
      finishedAt,
      output,
      silent,
    }
    if (error !== undefined) {
      run.error = error
    }
    this.own.emit('whales/routine-ran', run)
    return run
  }
}

export default Routines
