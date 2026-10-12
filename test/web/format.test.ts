import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plainPreview } from '../../web/src/lib/format.ts'

test('previews drop Markdown syntax', () => {
  assert.equal(plainPreview('**Room conclusion (news)**\nWe ship on *Friday* — see [notes](https://x.y).'), 'Room conclusion (news) We ship on Friday — see notes.')
  assert.equal(plainPreview('## Plan\n- a\n- b\n```js\ncode()\n```'), 'Plan a b')
  assert.equal(plainPreview('snake_case_name stays'), 'snake_case_name stays')
})
