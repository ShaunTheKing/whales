import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import { RuleParseError } from '../../src/contracts/rules.ts'
import type { Rule } from '../../src/contracts/rules.ts'
import type { Action, ActionKind, PermissionMode } from '../../src/contracts/core.ts'
import type {} from '../../src/contracts/index.ts'

import {
  parseRule,
  globToRegExp,
  normalizeTarget,
  matches,
  escapesWorkdir,
  evaluateRules,
  sentenceFor,
} from '../../src/services/rules.ts'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let seq = 0

function act(
  kind: ActionKind,
  target: string,
  extra: Partial<Action> = {},
): Action {
  seq += 1
  return {
    kind,
    target,
    agentId: extra.agentId ?? 'alice',
    summary: extra.summary ?? `${kind} ${target}`,
    ...(extra.roomId !== undefined ? { roomId: extra.roomId } : {}),
    ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
  }
}

function rule(
  effect: Rule['effect'],
  kind: ActionKind,
  pattern: string,
  scope: Rule['scope'] = 'global',
): Rule {
  return {
    id: `rule_${seq++}`,
    scope,
    effect,
    kind,
    pattern,
    sentence: `${effect} ${kind} ${pattern}`,
    createdAt: 0,
  }
}

const tmpDirs: string[] = []

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whales-rules-'))
  tmpDirs.push(dir)
  return dir
}

after(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// parseRule — grammar
// ---------------------------------------------------------------------------

test('parseRule: basic subjects map to kinds', () => {
  assert.equal(parseRule('allow reading files').kind, 'file.read')
  assert.equal(parseRule('allow writing files').kind, 'file.write')
  assert.equal(parseRule('allow editing files').kind, 'file.write')
  assert.equal(parseRule('allow running commands').kind, 'shell')
  assert.equal(parseRule('allow shell commands').kind, 'shell')
  assert.equal(parseRule('allow network access').kind, 'network')
  assert.equal(parseRule('allow fetching urls').kind, 'network')
  assert.equal(parseRule('allow sending messages').kind, 'message')
  assert.equal(parseRule('allow installing skills').kind, 'skill.install')
  assert.equal(parseRule('allow hiring agents').kind, 'agent.hire')
})

test('parseRule: effects', () => {
  assert.equal(parseRule('allow reading files').effect, 'allow')
  assert.equal(parseRule('deny reading files').effect, 'deny')
  assert.equal(parseRule('ask reading files').effect, 'ask')
  assert.equal(parseRule('ask before reading files').effect, 'ask')
})

test('parseRule: case-insensitive keywords', () => {
  const r = parseRule('ALLOW Reading Files')
  assert.equal(r.effect, 'allow')
  assert.equal(r.kind, 'file.read')
})

test('parseRule: whitespace collapsed and trailing dot stripped', () => {
  const r = parseRule('  allow   reading    files   in   src/**  .  ')
  assert.equal(r.effect, 'allow')
  assert.equal(r.kind, 'file.read')
  assert.equal(r.pattern, 'src/**')
  assert.equal(r.sentence, 'allow reading files in src/** .')
})

test('parseRule: sentence is trimmed and whitespace-collapsed', () => {
  const r = parseRule('\tallow\treading\tfiles\t')
  assert.equal(r.sentence, 'allow reading files')
})

test('parseRule: no pattern defaults to **', () => {
  assert.equal(parseRule('allow reading files').pattern, '**')
  assert.equal(parseRule('deny running commands').pattern, '**')
})

test('parseRule: prepositions', () => {
  for (const prep of ['in', 'under', 'matching', 'to', 'on']) {
    const r = parseRule(`allow reading files ${prep} src/**`)
    assert.equal(r.pattern, 'src/**', `preposition ${prep}`)
  }
})

test('parseRule: using tool NAME', () => {
  const r = parseRule('allow using tool remember')
  assert.equal(r.kind, 'tool')
  assert.equal(r.pattern, 'remember')
})

test('parseRule: using tools', () => {
  const r = parseRule('allow using tools')
  assert.equal(r.kind, 'tool')
  assert.equal(r.pattern, '**')
})

test('parseRule: using tool with invalid name throws', () => {
  assert.throws(() => parseRule('allow using tool Remember'), RuleParseError)
  assert.throws(() => parseRule('allow using tool 1abc'), RuleParseError)
  assert.throws(() => parseRule('allow using tool'), RuleParseError)
  assert.throws(() => parseRule('allow using tool remember extra'), RuleParseError)
})

test('parseRule: unknown subject throws', () => {
  assert.throws(() => parseRule('allow flying kites'), RuleParseError)
  assert.throws(() => parseRule('allow'), RuleParseError)
  assert.throws(() => parseRule(''), RuleParseError)
})

test('parseRule: unknown effect throws', () => {
  assert.throws(() => parseRule('maybe reading files'), RuleParseError)
})

test('parseRule: unknown preposition throws', () => {
  assert.throws(() => parseRule('allow reading files near src/**'), RuleParseError)
})

test('parseRule: missing pattern after preposition throws', () => {
  assert.throws(() => parseRule('allow reading files in'), RuleParseError)
})

test('parseRule: max 500 chars', () => {
  const long = `allow reading files in ${'a'.repeat(600)}`
  assert.throws(() => parseRule(long), RuleParseError)
})

// ---------------------------------------------------------------------------
// globToRegExp / matches
// ---------------------------------------------------------------------------

test('glob: file kinds — * and ? do not cross /', () => {
  const re = globToRegExp('src/*.ts', 'file.read')
  assert.equal(re.test('src/a.ts'), true)
  assert.equal(re.test('src/a/b.ts'), false)
})

test('glob: file kinds — ** crosses /', () => {
  const re = globToRegExp('src/**', 'file.read')
  assert.equal(re.test('src/a/b/c.ts'), true)
  assert.equal(re.test('src/a.ts'), true)
})

test('glob: non-file kinds — * matches /', () => {
  const re = globToRegExp('rm *', 'shell')
  assert.equal(re.test('rm -rf /'), true)
})

test('glob: regex metacharacters are literal', () => {
  const re = globToRegExp('notes.txt', 'file.read')
  assert.equal(re.test('notes.txt'), true)
  assert.equal(re.test('notesXtxt'), false)

  const re2 = globToRegExp('a+b', 'shell')
  assert.equal(re2.test('a+b'), true)
  assert.equal(re2.test('aab'), false)

  const re3 = globToRegExp('(x)', 'shell')
  assert.equal(re3.test('(x)'), true)
  assert.equal(re3.test('x'), false)

  const re4 = globToRegExp('a|b', 'shell')
  assert.equal(re4.test('a|b'), true)
  assert.equal(re4.test('a'), false)

  const re5 = globToRegExp('$^', 'shell')
  assert.equal(re5.test('$^'), true)
})

test('glob: anchored whole target', () => {
  const re = globToRegExp('rm *', 'shell')
  assert.equal(re.test('rm -rf /'), true)
  assert.equal(re.test('x rm -rf /'), false)
  // For shell targets '*' crosses spaces and slashes by design (deny 'rm *' must catch every rm invocation).
  assert.equal(re.test('rm -rf / y'), true)
  assert.equal(re.test('rmdir x'), false)
})

test('matches: kind mismatch never matches', () => {
  const shellDeny = rule('deny', 'shell', '**')
  assert.equal(matches(shellDeny, act('file.read', 'x')), false)
})

test('matches: tool rule for remember does not match remember_all', () => {
  const r = rule('allow', 'tool', 'remember')
  assert.equal(matches(r, act('tool', 'remember')), true)
  assert.equal(matches(r, act('tool', 'remember_all')), false)
})

// ---------------------------------------------------------------------------
// normalizeTarget
// ---------------------------------------------------------------------------

test('normalizeTarget: file kinds — backslashes, duplicate slashes, leading ./', () => {
  assert.equal(normalizeTarget({ kind: 'file.read', target: 'a\\b\\c' }), 'a/b/c')
  assert.equal(normalizeTarget({ kind: 'file.read', target: 'a//b///c' }), 'a/b/c')
  assert.equal(normalizeTarget({ kind: 'file.read', target: './a/b' }), 'a/b')
  assert.equal(normalizeTarget({ kind: 'file.read', target: '././a/b' }), 'a/b')
})

test('normalizeTarget: shell — whitespace runs collapsed', () => {
  assert.equal(normalizeTarget({ kind: 'shell', target: '  rm   -rf  /  ' }), 'rm -rf /')
})

test('normalizeTarget: others trimmed', () => {
  assert.equal(normalizeTarget({ kind: 'network', target: '  https://x  ' }), 'https://x')
})

// ---------------------------------------------------------------------------
// escapesWorkdir
// ---------------------------------------------------------------------------

test('escapesWorkdir: only file kinds', () => {
  assert.equal(escapesWorkdir({ kind: 'shell', target: '/etc/passwd' }), false)
  assert.equal(escapesWorkdir({ kind: 'network', target: '../x' }), false)
})

test('escapesWorkdir: absolute and drive paths', () => {
  assert.equal(escapesWorkdir({ kind: 'file.read', target: '/x' }), true)
  assert.equal(escapesWorkdir({ kind: 'file.read', target: 'C:x' }), true)
})

test('escapesWorkdir: .. segments', () => {
  assert.equal(escapesWorkdir({ kind: 'file.read', target: '../x' }), true)
  assert.equal(escapesWorkdir({ kind: 'file.read', target: 'src/../../etc' }), true)
  assert.equal(escapesWorkdir({ kind: 'file.read', target: './../x' }), true)
})

test('escapesWorkdir: a..b/c is not a segment', () => {
  assert.equal(escapesWorkdir({ kind: 'file.read', target: 'a..b/c' }), false)
})

// ---------------------------------------------------------------------------
// evaluateRules — precedence
// ---------------------------------------------------------------------------

test('evaluate: deny beats allow regardless of order', () => {
  const rules = [rule('allow', 'shell', '**'), rule('deny', 'shell', 'rm *')]
  const ev = evaluateRules(rules, act('shell', 'rm -rf /'), 'ask')
  assert.equal(ev.verdict, 'deny')
})

test('evaluate: ask beats allow', () => {
  const rules = [rule('allow', 'shell', '**'), rule('ask', 'shell', 'rm *')]
  const ev = evaluateRules(rules, act('shell', 'rm -rf /'), 'ask')
  assert.equal(ev.verdict, 'ask')
})

test('evaluate: no match — trusted allows', () => {
  const ev = evaluateRules([], act('shell', 'ls'), 'trusted')
  assert.equal(ev.verdict, 'allow')
})

test('evaluate: no match — ask/strict ask', () => {
  assert.equal(evaluateRules([], act('shell', 'ls'), 'ask').verdict, 'ask')
  assert.equal(evaluateRules([], act('shell', 'ls'), 'strict').verdict, 'ask')
})

test('evaluate: allow in strict mode becomes ask', () => {
  const rules = [rule('allow', 'shell', 'ls')]
  assert.equal(evaluateRules(rules, act('shell', 'ls'), 'strict').verdict, 'ask')
})

test('evaluate: allow in a room becomes ask', () => {
  const rules = [rule('allow', 'shell', 'ls')]
  const ev = evaluateRules(rules, act('shell', 'ls', { roomId: 'r1' }), 'ask')
  assert.equal(ev.verdict, 'ask')
})

test('evaluate: no match in a room asks even in trusted mode', () => {
  const ev = evaluateRules([], act('shell', 'ls', { roomId: 'r1' }), 'trusted')
  assert.equal(ev.verdict, 'ask')
})

test('evaluate: matched lists all matching rules', () => {
  const rules = [rule('allow', 'shell', '**'), rule('deny', 'shell', 'rm *')]
  const ev = evaluateRules(rules, act('shell', 'rm -rf /'), 'ask')
  assert.equal(ev.matched.length, 2)
})

test('evaluate: reason mentions deciding sentence', () => {
  const rules = [rule('deny', 'shell', 'rm *')]
  const ev = evaluateRules(rules, act('shell', 'rm -rf /'), 'ask')
  assert.ok(ev.reason.includes(rules[0]?.sentence ?? ''))
})

// ---------------------------------------------------------------------------
// evaluateRules — workdir escape
// ---------------------------------------------------------------------------

test('evaluate: escaping file action is never allowed', () => {
  const rules = [rule('allow', 'file.read', '**')]
  const ev = evaluateRules(rules, act('file.read', '../secrets.txt'), 'trusted')
  assert.equal(ev.verdict, 'ask')
})

test('evaluate: escaping file action with deny rule denies', () => {
  const rules = [rule('deny', 'file.read', '**')]
  const ev = evaluateRules(rules, act('file.read', '../secrets.txt'), 'trusted')
  assert.equal(ev.verdict, 'deny')
})

test('evaluate: allow src/** vs src/../secrets.txt escapes → ask', () => {
  const rules = [rule('allow', 'file.read', 'src/**')]
  const ev = evaluateRules(rules, act('file.read', 'src/../secrets.txt'), 'ask')
  assert.equal(ev.verdict, 'ask')
})

// ---------------------------------------------------------------------------
// evaluateRules — attacks
// ---------------------------------------------------------------------------

test('attack: extra spaces/tabs in denied command', () => {
  const rules = [rule('deny', 'shell', 'rm *')]
  const ev = evaluateRules(rules, act('shell', 'rm\t\t-rf\t/'), 'ask')
  assert.equal(ev.verdict, 'deny')
})

test('attack: denied command with leading/trailing spaces', () => {
  const rules = [rule('deny', 'shell', 'rm *')]
  const ev = evaluateRules(rules, act('shell', '   rm -rf /   '), 'ask')
  assert.equal(ev.verdict, 'deny')
})

test('attack: deny rm * vs target rm (no args)', () => {
  const rules = [rule('deny', 'shell', 'rm *')]
  const ev = evaluateRules(rules, act('shell', 'rm'), 'ask')
  // pattern 'rm *' requires 'rm ' prefix; bare 'rm' does not match
  assert.equal(ev.verdict, 'ask')
})

test('attack: allow src/*.ts vs src/a/b.ts (no match)', () => {
  const rules = [rule('allow', 'file.read', 'src/*.ts')]
  const ev = evaluateRules(rules, act('file.read', 'src/a/b.ts'), 'ask')
  assert.equal(ev.verdict, 'ask')
})

test('attack: allow notes.txt vs notesXtxt (dot literal)', () => {
  const rules = [rule('allow', 'file.read', 'notes.txt')]
  const ev = evaluateRules(rules, act('file.read', 'notesXtxt'), 'ask')
  assert.equal(ev.verdict, 'ask')
})

test('attack: global deny + agent allow → deny', () => {
  const rules = [
    rule('deny', 'shell', 'rm *', 'global'),
    rule('allow', 'shell', '**', 'agent:alice'),
  ]
  const ev = evaluateRules(rules, act('shell', 'rm -rf /', { agentId: 'alice' }), 'ask')
  assert.equal(ev.verdict, 'deny')
})

test('attack: agent deny + global allow → deny', () => {
  const rules = [
    rule('allow', 'shell', '**', 'global'),
    rule('deny', 'shell', 'rm *', 'agent:alice'),
  ]
  const ev = evaluateRules(rules, act('shell', 'rm -rf /', { agentId: 'alice' }), 'ask')
  assert.equal(ev.verdict, 'deny')
})

test('attack: another agent rules never affect evaluate', () => {
  const rules = [rule('deny', 'shell', 'rm *', 'agent:bob')]
  const ev = evaluateRules(rules, act('shell', 'rm -rf /', { agentId: 'alice' }), 'ask')
  assert.equal(ev.verdict, 'ask')
})

// ---------------------------------------------------------------------------
// sentenceFor
// ---------------------------------------------------------------------------

test('sentenceFor: tool', () => {
  const s = sentenceFor({ kind: 'tool', target: 'remember' })
  assert.equal(s, 'allow using tool remember')
  const parsed = parseRule(s)
  assert.equal(parsed.kind, 'tool')
  assert.equal(parsed.pattern, 'remember')
})

test('sentenceFor: file — * and ? replaced by ?', () => {
  const s = sentenceFor({ kind: 'file.read', target: 'src/a.ts' })
  const parsed = parseRule(s)
  assert.equal(parsed.kind, 'file.read')
  assert.equal(matches(parsed, act('file.read', 'src/a.ts')), true)
})

test('sentenceFor: result parses and matches original action', () => {
  const action = act('shell', 'rm -rf /')
  const s = sentenceFor(action)
  const parsed = parseRule(s)
  assert.equal(matches(parsed, action), true)
})

// ---------------------------------------------------------------------------
// Rules service
// ---------------------------------------------------------------------------

test('Rules service: add persists and returns rule', async () => {
  const home = await makeTmp()
  const app = await createApp({
    config: defaultConfig({ env: {}, home, cwd: home }),
    storePath: ':memory:',
  })
  try {
    const r = app.ctx.rules.add('deny running commands matching rm *')
    assert.ok(r.id.startsWith('rule_'))
    assert.equal(r.scope, 'global')
    const listed = app.ctx.rules.list()
    assert.ok(listed.some((x) => x.id === r.id))
  } finally {
    await app.stop()
  }
})

test('Rules service: invalid scope throws TypeError', async () => {
  const home = await makeTmp()
  const app = await createApp({
    config: defaultConfig({ env: {}, home, cwd: home }),
    storePath: ':memory:',
  })
  try {
    assert.throws(() => app.ctx.rules.add('allow reading files', 'agent:Bad Id' as Rule['scope']), TypeError)
    assert.throws(() => app.ctx.rules.add('allow reading files', 'room:x' as Rule['scope']), TypeError)
  } finally {
    await app.stop()
  }
})

test('Rules service: list scoping', async () => {
  const home = await makeTmp()
  const app = await createApp({
    config: defaultConfig({ env: {}, home, cwd: home }),
    storePath: ':memory:',
  })
  try {
    const g = app.ctx.rules.add('allow reading files')
    const a = app.ctx.rules.add('deny running commands matching rm *', 'agent:alice')
    const b = app.ctx.rules.add('deny running commands matching ls *', 'agent:bob')

    const globalList = app.ctx.rules.list()
    assert.ok(globalList.some((x) => x.id === g.id))
    assert.ok(!globalList.some((x) => x.id === a.id))

    const aliceList = app.ctx.rules.list('agent:alice')
    assert.ok(aliceList.some((x) => x.id === g.id))
    assert.ok(aliceList.some((x) => x.id === a.id))
    assert.ok(!aliceList.some((x) => x.id === b.id))
  } finally {
    await app.stop()
  }
})

test('Rules service: remove true/false', async () => {
  const home = await makeTmp()
  const app = await createApp({
    config: defaultConfig({ env: {}, home, cwd: home }),
    storePath: ':memory:',
  })
  try {
    const r = app.ctx.rules.add('allow reading files')
    assert.equal(app.ctx.rules.remove(r.id), true)
    assert.equal(app.ctx.rules.remove(r.id), false)
  } finally {
    await app.stop()
  }
})

test('Rules service: evaluate uses global + agent rules', async () => {
  const home = await makeTmp()
  const app = await createApp({
    config: defaultConfig({ env: {}, home, cwd: home }),
    storePath: ':memory:',
  })
  try {
    app.ctx.rules.add('deny running commands matching rm *', 'agent:alice')
    const ev = app.ctx.rules.evaluate(act('shell', 'rm -rf x', { agentId: 'alice' }), 'ask')
    assert.equal(ev.verdict, 'deny')
    const ev2 = app.ctx.rules.evaluate(act('shell', 'rm -rf x', { agentId: 'bob' }), 'ask')
    assert.equal(ev2.verdict, 'ask')
  } finally {
    await app.stop()
  }
})

test('Rules service: spawned agent spec rules apply', async () => {
  const home = await makeTmp()
  const app = await createApp({
    config: defaultConfig({ env: {}, home, cwd: home }),
    storePath: ':memory:',
  })
  try {
    await app.ctx.agents.spawn(
      {
        id: 'alice',
        name: 'Alice',
        seniority: 1,
        driver: { name: 'driver-stub', config: { template: '{prompt}' } },
        plugins: [],
        rules: ['deny running commands matching rm *'],
      },
      { persist: false },
    )
    const ev = app.ctx.rules.evaluate(act('shell', 'rm -rf x', { agentId: 'alice' }), 'ask')
    assert.equal(ev.verdict, 'deny')
    const ev2 = app.ctx.rules.evaluate(act('shell', 'rm -rf x', { agentId: 'bob' }), 'ask')
    assert.equal(ev2.verdict, 'ask')
  } finally {
    await app.stop()
  }
})

test('Rules service: unparseable spec rule fails to spawn', async () => {
  const home = await makeTmp()
  const app = await createApp({
    config: defaultConfig({ env: {}, home, cwd: home }),
    storePath: ':memory:',
  })
  try {
    await assert.rejects(
      Promise.resolve(
        app.ctx.agents.spawn(
          {
            id: 'bad',
            name: 'Bad',
            seniority: 1,
            driver: { name: 'driver-stub', config: { template: '{prompt}' } },
            plugins: [],
            rules: ['allow flying kites'],
          },
          { persist: false },
        ),
      ),
    )
  } finally {
    await app.stop()
  }
})
