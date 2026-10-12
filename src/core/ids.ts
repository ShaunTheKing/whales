import { randomInt } from 'node:crypto'

const PREFIX_RE = /^[a-z]{1,8}$/
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

let lastTime = -1
let lastRand: number[] = []

/** Base-36 increment of the random part; an all-'z' overflow (≈1 in 36^10) borrows the next millisecond. */
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    if ((digits[i] ?? 0) < 35) {
      digits[i] = (digits[i] ?? 0) + 1
      return true
    }
    digits[i] = 0
  }
  return false
}

/**
 * Generate a sortable, collision-resistant id of the form `${prefix}_${time}${rand}`.
 *
 * - `time` is `Date.now().toString(36)` left-padded to 9 chars.
 * - `rand` is 10 chars from `[0-9a-z]` via `crypto.randomInt`. Within one millisecond (or if the clock goes
 *   backwards) the previous `rand` is incremented instead (ULID-style monotonicity), so ids from one process
 *   always sort in creation order. Records ordered by (createdAt, id) therefore keep insertion order on ties.
 *
 * @throws {TypeError} when `prefix` does not match `/^[a-z]{1,8}$/`.
 */
export function newId(prefix: string): string {
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) {
    throw new TypeError(`newId: invalid prefix ${JSON.stringify(prefix)}`)
  }
  let now = Date.now()
  if (now <= lastTime) {
    now = lastTime
    if (!increment(lastRand)) now = lastTime + 1
  }
  if (now > lastTime) {
    lastRand = Array.from({ length: 10 }, () => randomInt(ALPHABET.length))
    lastTime = now
  }
  const time = now.toString(36).padStart(9, '0')
  return `${prefix}_${time}${lastRand.map((d) => ALPHABET[d]).join('')}`
}

/** True when `s` is a valid agent id (`/^[a-z0-9][a-z0-9-]{0,31}$/`). */
export function isAgentId(s: unknown): s is string {
  return typeof s === 'string' && AGENT_ID_RE.test(s)
}

/** Assert that `s` is a valid agent id. @throws {TypeError} */
export function assertAgentId(s: unknown): asserts s is string {
  if (!isAgentId(s)) {
    throw new TypeError(`assertAgentId: invalid agent id ${JSON.stringify(s)}`)
  }
}

/** True when `s` is a valid skill name (`/^[a-z0-9][a-z0-9-]{0,63}$/`). */
export function isSkillName(s: unknown): s is string {
  return typeof s === 'string' && SKILL_NAME_RE.test(s)
}

/** True when `s` is a valid tool name (`/^[a-z][a-z0-9_]{0,63}$/`). */
export function isToolName(s: unknown): s is string {
  return typeof s === 'string' && TOOL_NAME_RE.test(s)
}
