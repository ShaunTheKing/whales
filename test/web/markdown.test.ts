import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBlocks } from '../../web/src/lib/markdown-parse.ts'

test('a line that is entirely bold becomes a heading (the room conclusion case)', () => {
  const blocks = parseBlocks('**Room conclusion (news)**\nThe team agrees on Friday.')
  assert.deepEqual(blocks, [
    { type: 'heading', level: 4, text: 'Room conclusion (news)' },
    { type: 'paragraph', lines: ['The team agrees on Friday.'] },
  ])
  assert.deepEqual(parseBlocks('Intro line\n**Conclusion:**\nDone')[1], { type: 'heading', level: 4, text: 'Conclusion:' })
  // Bold inside a sentence stays inline.
  assert.deepEqual(parseBlocks('We **agree** on it.'), [{ type: 'paragraph', lines: ['We **agree** on it.'] }])
  assert.equal(parseBlocks('**a** and **b**')[0]?.type, 'paragraph')
})

test('headings, rules, quotes, code fences (also unterminated while streaming)', () => {
  assert.deepEqual(parseBlocks('## Plan ##'), [{ type: 'heading', level: 2, text: 'Plan' }])
  assert.deepEqual(parseBlocks('---'), [{ type: 'rule' }])
  assert.deepEqual(parseBlocks('> a\n> b'), [{ type: 'quote', lines: ['a', 'b'] }])
  assert.deepEqual(parseBlocks('```ts\nconst x = 1\n```\nafter'), [
    { type: 'code', lang: 'ts', text: 'const x = 1' },
    { type: 'paragraph', lines: ['after'] },
  ])
  assert.deepEqual(parseBlocks('```\npartial'), [{ type: 'code', lang: '', text: 'partial' }])
})

test('lists: bullets, ordered with start, nesting, continuation lines', () => {
  const [list] = parseBlocks('- one\n- two\n  - nested\n- three')
  assert.equal(list?.type, 'list')
  if (list?.type !== 'list') return
  assert.equal(list.ordered, false)
  assert.deepEqual(list.items.map((i) => i.text), ['one', 'two', 'three'])
  assert.deepEqual(list.items[1]?.children.map((i) => i.text), ['nested'])
  const [ordered] = parseBlocks('3. c\n4. d')
  assert.equal(ordered?.type === 'list' && ordered.ordered && ordered.start, 3)
  const [cont] = parseBlocks('- first\n  more text')
  assert.equal(cont?.type === 'list' && cont.items[0]?.text, 'first\nmore text')
})

test('tables with alignment', () => {
  const [table] = parseBlocks('| Name | Score |\n|:---|---:|\n| Ann | 3 |\n| Bob | 5 |')
  assert.deepEqual(table, { type: 'table', header: ['Name', 'Score'], align: ['left', 'right'], rows: [['Ann', '3'], ['Bob', '5']] })
})

test('never loops forever on odd input', () => {
  for (const input of ['|', '**', '** **', '- ', '#', '```', '>', '1.', '| a |\n|', '***\n***', 'a|b\n---']) {
    assert.ok(Array.isArray(parseBlocks(input)), input)
  }
})

test('bullets followed by numbers become two lists; tables accept short delimiter rows', () => {
  const blocks = parseBlocks('- a\n- b\n1. one\n2. two')
  assert.deepEqual(blocks.map((b) => b.type === 'list' && b.ordered), [false, true])
  const [table] = parseBlocks('| T | O |\n|:--|--:|\n| x | y |')
  assert.equal(table?.type, 'table')
})
