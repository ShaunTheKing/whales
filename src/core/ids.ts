import { randomInt } from 'node:crypto'

const PREFIX_RE = /^[a-z]{1,8}$/
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/**
 * Generate a sortable, collision-resistant id of the form `${prefix}_${time}${rand}`.
 *
 * - `time` is `Date.now().toString(36)` left-padded to 9 chars, so ids created in
 *   later milliseconds sort lexicographically after earlier ones.
 * - `rand` is 10 chars drawn uniformly from `[0-9a-z]` via `crypto.randomInt`.
 *
 * @throws {TypeError} when `prefix` does not match `/^[a-z]{1,8}$/`.
 */
export function newId(prefix: string): string {
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) {
    throw new TypeError(`newId: invalid prefix ${JSON.stringify(prefix)}`)
  }
  const time = Date.now().toString(36).padStart(9, '0')
  let rand = ''
  for (let i = 0; i < 10; i++) {
    rand += ALPHABET[randomInt(ALPHABET.length)]
  }
  return `${prefix}_${time}${rand}`
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
