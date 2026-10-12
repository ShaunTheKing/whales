import type { Action, ActionKind, PermissionMode, Scope, Verdict } from './core.ts'
import type { BaseRecord } from './store.ts'

/**
 * A parsed sentence rule. Grammar (case-insensitive, see ARCHITECTURE.md §Rules):
 *   <effect> <subject> [<preposition> <pattern>]
 *   effect      := allow | deny | ask [before]
 *   subject     := reading files | writing files | editing files | running commands | shell commands
 *                | network access | fetching urls | using tool <name> | using tools | sending messages
 *                | installing skills | hiring agents
 *   preposition := in | under | matching | to | on
 *   pattern     := glob (`*`, `**`, `?`); absent = everything
 */
export interface Rule extends BaseRecord {
  scope: 'global' | `agent:${string}`
  effect: Verdict
  kind: ActionKind
  /** Glob against `Action.target`; for `tool` the subject's <name> is the pattern. */
  pattern: string
  /** The original sentence, kept verbatim for display. */
  sentence: string
}

export class RuleParseError extends Error {
  override name = 'RuleParseError'
}

export interface RuleEvaluation {
  verdict: Verdict
  /** Rules that matched the action (all of them, any effect). */
  matched: Rule[]
  /** Human-readable explanation, e.g. `denied by "deny running commands matching rm *"`. */
  reason: string
}

export interface RulesService {
  /** Pure parse. Throws RuleParseError with a helpful message. */
  parse(sentence: string): Pick<Rule, 'effect' | 'kind' | 'pattern' | 'sentence'>
  add(sentence: string, scope?: Rule['scope']): Rule
  remove(id: string): boolean
  /** Global rules plus, if given, one agent's rules. */
  list(scope?: Scope): Rule[]
  /**
   * Pure, synchronous decision. Considers global rules and `agent:<action.agentId>` rules.
   * Precedence: deny > ask > allow > mode default. In a room (`action.roomId`) allow → ask.
   */
  evaluate(action: Action, mode: PermissionMode): RuleEvaluation
}

declare module './store.ts' {
  interface Collections {
    rules: Rule
  }
}

declare module 'cordis' {
  interface Context {
    rules: RulesService
  }
}
