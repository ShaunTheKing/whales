import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  newId,
  isAgentId,
  assertAgentId,
  isSkillName,
  isToolName,
} from '../../src/core/ids.ts'

const ID_RE = /^[a-z]{1,8}_[0-9a-z]{19}$/

describe('newId', () => {
  test('produces prefix_time+rand format', () => {
    const id = newId('agent')
    assert.match(id, ID_RE)
    assert.ok(id.startsWith('agent_'))
    assert.equal(id.length, 'agent_'.length + 19)
  })

  test('suffix is exactly 19 chars', () => {
    const id = newId('a')
    const suffix = id.slice(id.indexOf('_') + 1)
    assert.equal(suffix.length, 19)
    assert.match(suffix, /^[0-9a-z]{19}$/)
  })

  test('accepts 1-char and 8-char prefixes', () => {
    assert.match(newId('a'), ID_RE)
    assert.match(newId('abcdefgh'), ID_RE)
  })

  test('rejects invalid prefixes with TypeError', () => {
    assert.throws(() => newId(''), TypeError)
    assert.throws(() => newId('abcdefghi'), TypeError)
    assert.throws(() => newId('Agent'), TypeError)
    assert.throws(() => newId('a1'), TypeError)
    assert.throws(() => newId('a-b'), TypeError)
    assert.throws(() => newId('a_b'), TypeError)
    assert.throws(() => newId(' agent'), TypeError)
  })

  test('1000 calls produce 1000 distinct ids', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      seen.add(newId('agent'))
    }
    assert.equal(seen.size, 1000)
  })

  test('ids from later milliseconds sort lexicographically after earlier ones', async () => {
    const first = newId('agent')
    await new Promise<void>((resolve) => setTimeout(resolve, 2))
    const second = newId('agent')
    assert.ok(first < second, `${first} should sort before ${second}`)
  })
})

describe('isAgentId', () => {
  test('accepts valid ids', () => {
    assert.equal(isAgentId('a'), true)
    assert.equal(isAgentId('agent-1'), true)
    assert.equal(isAgentId('0'), true)
    assert.equal(isAgentId('a'.repeat(32)), true)
  })

  test('rejects invalid ids', () => {
    assert.equal(isAgentId(''), false)
    assert.equal(isAgentId('A'), false)
    assert.equal(isAgentId('-a'), false)
    assert.equal(isAgentId('a_b'), false)
    assert.equal(isAgentId('a'.repeat(33)), false)
  })

  test('rejects non-strings without throwing', () => {
    assert.equal(isAgentId(undefined), false)
    assert.equal(isAgentId(null), false)
    assert.equal(isAgentId(42), false)
    assert.equal(isAgentId({}), false)
    assert.equal(isAgentId(['a']), false)
  })
})

describe('assertAgentId', () => {
  test('returns for valid ids', () => {
    assert.doesNotThrow(() => assertAgentId('agent-1'))
  })

  test('throws TypeError mentioning the bad value', () => {
    assert.throws(
      () => assertAgentId('Bad_Id'),
      (err: unknown) => {
        assert.ok(err instanceof TypeError)
        assert.ok(err.message.includes('Bad_Id'))
        return true
      },
    )
  })

  test('throws for non-strings', () => {
    assert.throws(() => assertAgentId(123), TypeError)
    assert.throws(() => assertAgentId(undefined), TypeError)
  })
})

describe('isSkillName', () => {
  test('accepts valid names', () => {
    assert.equal(isSkillName('a'), true)
    assert.equal(isSkillName('skill-1'), true)
    assert.equal(isSkillName('a'.repeat(64)), true)
  })

  test('rejects invalid names', () => {
    assert.equal(isSkillName(''), false)
    assert.equal(isSkillName('A'), false)
    assert.equal(isSkillName('-a'), false)
    assert.equal(isSkillName('a_b'), false)
    assert.equal(isSkillName('a'.repeat(65)), false)
  })

  test('rejects non-strings without throwing', () => {
    assert.equal(isSkillName(undefined), false)
    assert.equal(isSkillName(null), false)
    assert.equal(isSkillName(1), false)
    assert.equal(isSkillName({}), false)
  })
})

describe('isToolName', () => {
  test('accepts valid names', () => {
    assert.equal(isToolName('a'), true)
    assert.equal(isToolName('read_file'), true)
    assert.equal(isToolName('a1_b2'), true)
    assert.equal(isToolName('a'.repeat(64)), true)
  })

  test('rejects invalid names', () => {
    assert.equal(isToolName(''), false)
    assert.equal(isToolName('1tool'), false)
    assert.equal(isToolName('_tool'), false)
    assert.equal(isToolName('tool-name'), false)
    assert.equal(isToolName('Tool'), false)
    assert.equal(isToolName('a'.repeat(65)), false)
  })

  test('rejects non-strings without throwing', () => {
    assert.equal(isToolName(undefined), false)
    assert.equal(isToolName(null), false)
    assert.equal(isToolName(1), false)
    assert.equal(isToolName({}), false)
  })
})
