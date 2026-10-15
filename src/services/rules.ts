import { Service, type Context } from 'cordis'
import type { Action, ActionKind, PermissionMode, Scope, Verdict } from '../contracts/core.ts'
import { RuleParseError, type Rule, type RuleEvaluation, type RulesService } from '../contracts/rules.ts'
import { isAgentId, newId } from '../core/ids.ts'

/**
 * SECURITY-CRITICAL (orchestrator-owned). Sentence rules → allow / deny / ask.
 * Grammar and precedence are documented in ARCHITECTURE.md §5. `evaluate` is pure and synchronous.
 */

type Parsed = Pick<Rule, 'effect' | 'kind' | 'pattern' | 'sentence'>

/** Subject phrases, longest first so "using tools" is not read as "using tool s". */
const SUBJECTS: { phrase: string; kind: ActionKind; named?: true }[] = [
  { phrase: 'reading files', kind: 'file.read' },
  { phrase: 'writing files', kind: 'file.write' },
  { phrase: 'editing files', kind: 'file.write' },
  { phrase: 'running commands', kind: 'shell' },
  { phrase: 'shell commands', kind: 'shell' },
  { phrase: 'network access', kind: 'network' },
  { phrase: 'fetching urls', kind: 'network' },
  { phrase: 'using tools', kind: 'tool' },
  { phrase: 'using tool', kind: 'tool', named: true },
  { phrase: 'sending messages', kind: 'message' },
  { phrase: 'installing skills', kind: 'skill.install' },
  { phrase: 'hiring agents', kind: 'agent.hire' },
]
const PREPOSITIONS = ['in', 'under', 'matching', 'to', 'on']
const SUBJECT_FOR_KIND: Record<ActionKind, string> = {
  'file.read': 'reading files',
  'file.write': 'writing files',
  shell: 'running commands',
  network: 'network access',
  tool: 'using tool',
  message: 'sending messages',
  'skill.install': 'installing skills',
  'agent.hire': 'hiring agents',
}

export function parseRule(input: string): Parsed {
  if (typeof input !== 'string') throw new RuleParseError('rule must be a string')
  const sentence = input.trim().replace(/\s+/g, ' ')
  if (sentence.length === 0 || sentence.length > 500) throw new RuleParseError('rule must be 1..500 characters')
  let rest = sentence.replace(/\.$/, '')
  const lower = () => rest.toLowerCase()

  let effect: Verdict
  if (/^allow\s/i.test(rest)) effect = 'allow'
  else if (/^deny\s/i.test(rest)) effect = 'deny'
  else if (/^ask\s/i.test(rest)) effect = 'ask'
  else throw new RuleParseError(`rule must start with allow, deny or ask: "${sentence}"`)
  rest = rest.slice(effect.length).trimStart()
  if (effect === 'ask' && /^before\s/i.test(rest)) rest = rest.slice('before'.length).trimStart()

  const subject = SUBJECTS.find((s) => lower() === s.phrase || lower().startsWith(s.phrase + ' '))
  if (!subject) {
    throw new RuleParseError(`unknown subject in "${sentence}"; expected one of: ${[...new Set(SUBJECTS.map((s) => s.phrase))].join(', ')}`)
  }
  rest = rest.slice(subject.phrase.length).trimStart()

  if (subject.named) {
    const name = rest.split(' ')[0] ?? ''
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new RuleParseError(`"using tool" needs a tool name in "${sentence}"`)
    rest = rest.slice(name.length).trim()
    if (rest) throw new RuleParseError(`unexpected text after tool name in "${sentence}"`)
    return { effect, kind: subject.kind, pattern: name, sentence }
  }

  if (!rest) return { effect, kind: subject.kind, pattern: '**', sentence }
  const preposition = PREPOSITIONS.find((p) => lower().startsWith(p + ' '))
  if (!preposition) throw new RuleParseError(`expected one of ${PREPOSITIONS.join(', ')} before the pattern in "${sentence}"`)
  const pattern = rest.slice(preposition.length).trim()
  if (!pattern) throw new RuleParseError(`missing pattern in "${sentence}"`)
  return { effect, kind: subject.kind, pattern, sentence }
}

/**
 * Glob → anchored RegExp. `**` any characters, `*` any characters except '/', `?` one character
 * except '/'. Everything else is literal. Shell targets are matched with '/' treated like any other char
 * (`*` crosses it), because command lines are not paths.
 */
export function globToRegExp(pattern: string, kind: ActionKind): RegExp {
  const pathLike = kind === 'file.read' || kind === 'file.write'
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
      } else {
        re += pathLike ? '[^/]*' : '.*'
      }
    } else if (ch === '?') {
      re += pathLike ? '[^/]' : '.'
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`, 's')
}

/**
 * Canonical form of a target before matching.
 * - files: workdir-relative POSIX path; leading './' and duplicate slashes removed. Absolute paths and any '..'
 *   segment are returned unchanged so no allow pattern written for relative paths can match them
 *   (confinement to the workdir is enforced by the caller before rules are consulted).
 * - shell: whitespace collapsed and trimmed, so extra spaces cannot dodge a deny pattern.
 */
export function normalizeTarget(action: Pick<Action, 'kind' | 'target'>): string {
  const target = action.target
  if (action.kind === 'file.read' || action.kind === 'file.write') {
    let p = target.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
    while (p.startsWith('./')) p = p.slice(2)
    return p
  }
  if (action.kind === 'shell') return target.trim().replace(/\s+/g, ' ')
  return target.trim()
}

export function matches(rule: Pick<Rule, 'kind' | 'pattern'>, action: Pick<Action, 'kind' | 'target'>): boolean {
  if (rule.kind !== action.kind) return false
  const target = normalizeTarget(action)
  return globToRegExp(rule.pattern, rule.kind).test(target)
}

/** File targets outside the workdir-relative namespace (absolute, or with a '..' segment). */
export function escapesWorkdir(action: Pick<Action, 'kind' | 'target'>): boolean {
  if (action.kind !== 'file.read' && action.kind !== 'file.write') return false
  const target = normalizeTarget(action)
  return target.startsWith('/') || /^[a-zA-Z]:/.test(target) || target.split('/').includes('..')
}

export function evaluateRules(rules: readonly Rule[], action: Action, mode: PermissionMode): RuleEvaluation {
  // Defence in depth: only global rules and this agent's own rules apply, whatever the caller passed in.
  const applicable = rules.filter((rule) => rule.scope === 'global' || rule.scope === `agent:${action.agentId}`)
  const matched = applicable.filter((rule) => matches(rule, action))
  if (escapesWorkdir(action)) {
    // Defence in depth: never auto-allow a path outside the workdir, whatever the rules or mode say.
    const deny = matched.find((rule) => rule.effect === 'deny')
    if (deny) return { verdict: 'deny', matched, reason: `denied by rule "${deny.sentence}"` }
    return { verdict: 'ask', matched, reason: 'path is outside the agent workdir' }
  }
  const first = (effect: Verdict) => matched.find((rule) => rule.effect === effect)
  const deny = first('deny')
  if (deny) return { verdict: 'deny', matched, reason: `denied by rule "${deny.sentence}"` }
  const ask = first('ask')
  if (ask) return { verdict: 'ask', matched, reason: `rule "${ask.sentence}" requires approval` }
  if (mode === 'auto') return { verdict: 'allow', matched, reason: 'auto mode' }
  if (mode === 'edits' && (action.kind === 'file.read' || action.kind === 'file.write')) {
    return { verdict: 'allow', matched, reason: 'allow-edits mode' }
  }
  const allow = first('allow')
  if (allow) {
    if (action.roomId !== undefined) return { verdict: 'ask', matched, reason: `shared rooms always ask (allowed by "${allow.sentence}")` }
    if (mode === 'strict') return { verdict: 'ask', matched, reason: `strict mode asks (allowed by "${allow.sentence}")` }
    return { verdict: 'allow', matched, reason: `allowed by rule "${allow.sentence}"` }
  }
  if (mode === 'trusted' && action.roomId === undefined) return { verdict: 'allow', matched, reason: 'trusted mode, no rule matched' }
  return { verdict: 'ask', matched, reason: 'no rule matched' }
}

/** Sentence for an `allow-always` decision: exactly this kind and this literal target. */
export function sentenceFor(action: Pick<Action, 'kind' | 'target'>): string {
  if (action.kind === 'tool') return `allow using tool ${action.target}`
  const literal = normalizeTarget(action).replace(/[*?]/g, '?')
  return `allow ${SUBJECT_FOR_KIND[action.kind]} matching ${literal}`
}

export class Rules extends Service implements RulesService {
  static inject = ['store']

  private store: Context['store']
  private own: Context

  constructor(ctx: Context) {
    super(ctx, 'rules')
    this.store = ctx.store
    this.own = ctx
  }

  parse(sentence: string): Parsed {
    return parseRule(sentence)
  }

  add(sentence: string, scope: Rule['scope'] = 'global'): Rule {
    if (scope !== 'global' && !(scope.startsWith('agent:') && isAgentId(scope.slice(6)))) {
      throw new TypeError(`rules: invalid scope ${JSON.stringify(scope)}`)
    }
    const rule: Rule = { id: newId('rule'), scope, createdAt: Date.now(), ...parseRule(sentence) }
    return this.store.collection('rules').put(rule)
  }

  remove(id: string): boolean {
    return this.store.collection('rules').delete(id)
  }

  list(scope?: Scope): Rule[] {
    const rules = this.store.collection('rules')
    const global = rules.list({ scope: 'global' })
    if (scope === undefined || scope === 'global' || !scope.startsWith('agent:')) return global
    return [...global, ...rules.list({ scope: scope as Rule['scope'] })]
  }

  evaluate(action: Action, mode: PermissionMode): RuleEvaluation {
    return evaluateRules([...this.list(`agent:${action.agentId}`), ...this.specRules(action.agentId)], action, mode)
  }

  /** Rules written in the agent's spec. Applied live (never copied into the store), validated at spawn. */
  private specRules(agentId: string): Rule[] {
    const sentences = this.own.get('agents')?.get(agentId)?.spec.rules ?? []
    const rules: Rule[] = []
    for (const sentence of sentences) {
      try {
        rules.push({ id: `spec:${agentId}:${rules.length}`, scope: `agent:${agentId}`, createdAt: 0, ...parseRule(sentence) })
      } catch {
        // Unreachable for spawned agents (validateSpec parses every rule); a bad rule must not widen access.
        rules.push({ id: `spec:${agentId}:${rules.length}`, scope: `agent:${agentId}`, createdAt: 0, effect: 'ask', kind: 'tool', pattern: '**', sentence })
      }
    }
    return rules
  }
}
