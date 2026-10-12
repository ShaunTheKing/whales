import { test, describe, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { openStore } from '../../src/services/store.ts'
import type { StoreHandle } from '../../src/services/store.ts'
import type { BaseRecord } from '../../src/contracts/store.ts'

interface Note extends BaseRecord {
  text: string
  tags?: string[]
}

declare module '../../src/contracts/store.ts' {
  interface Collections {
    testNotes: Note
    testOther: Note
  }
}

const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whales-store-'))
  tmpDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function note(id: string, createdAt: number, extra?: Partial<Note>): Note {
  return {
    id,
    scope: 'global',
    createdAt,
    text: `note-${id}`,
    ...extra,
  }
}

describe('store: put/get', () => {
  let store: StoreHandle

  beforeEach(() => {
    store = openStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  test('round-trips a record with nested data', () => {
    const notes = store.collection('testNotes')
    const record: Note = {
      id: 'n1',
      scope: 'agent:alpha',
      createdAt: 1000,
      text: 'hello',
      tags: ['a', 'b'],
    }
    const returned = notes.put(record)
    assert.deepEqual(returned, record)

    const got = notes.get('n1')
    assert.deepEqual(got, record)
  })

  test('get returns undefined for a missing id', () => {
    const notes = store.collection('testNotes')
    assert.equal(notes.get('nope'), undefined)
  })

  test('replace by id keeps a single row', () => {
    const notes = store.collection('testNotes')
    notes.put(note('n1', 1000, { text: 'first' }))
    notes.put(note('n1', 1000, { text: 'second' }))

    assert.equal(notes.count(), 1)
    const got = notes.get('n1')
    assert.equal(got?.text, 'second')
  })

  test('mutating a returned record does not affect the store', () => {
    const notes = store.collection('testNotes')
    notes.put(note('n1', 1000, { text: 'original', tags: ['x'] }))

    const first = notes.get('n1')
    assert.ok(first)
    first.text = 'mutated'
    first.tags?.push('y')

    const second = notes.get('n1')
    assert.equal(second?.text, 'original')
    assert.deepEqual(second?.tags, ['x'])
  })

  test('mutating the object passed to put does not affect the store', () => {
    const notes = store.collection('testNotes')
    const record = note('n1', 1000, { text: 'original', tags: ['x'] })
    notes.put(record)

    record.text = 'mutated'
    record.tags?.push('y')

    const got = notes.get('n1')
    assert.equal(got?.text, 'original')
    assert.deepEqual(got?.tags, ['x'])
  })

  test('collections are isolated even with equal ids', () => {
    const notes = store.collection('testNotes')
    const other = store.collection('testOther')

    notes.put(note('same', 1000, { text: 'in-notes' }))
    other.put(note('same', 1000, { text: 'in-other' }))

    assert.equal(notes.get('same')?.text, 'in-notes')
    assert.equal(other.get('same')?.text, 'in-other')
    assert.equal(notes.count(), 1)
    assert.equal(other.count(), 1)
  })
})

describe('store: put validation', () => {
  let store: StoreHandle

  beforeEach(() => {
    store = openStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  test('rejects non-object records', () => {
    const notes = store.collection('testNotes')
    assert.throws(() => notes.put(null as unknown as Note), TypeError)
    assert.throws(() => notes.put(undefined as unknown as Note), TypeError)
    assert.throws(() => notes.put('str' as unknown as Note), TypeError)
    assert.throws(() => notes.put(42 as unknown as Note), TypeError)
  })

  test('rejects empty or non-string ids', () => {
    const notes = store.collection('testNotes')
    assert.throws(() => notes.put(note('', 1000)), TypeError)
    assert.throws(() => notes.put({ ...note('x', 1000), id: 5 as unknown as string }), TypeError)
  })

  test('rejects empty or non-string scopes', () => {
    const notes = store.collection('testNotes')
    assert.throws(() => notes.put({ ...note('n1', 1000), scope: '' as never }), TypeError)
    assert.throws(() => notes.put({ ...note('n1', 1000), scope: 7 as never }), TypeError)
  })

  test('rejects non-finite createdAt', () => {
    const notes = store.collection('testNotes')
    assert.throws(() => notes.put({ ...note('n1', 1000), createdAt: Number.NaN }), TypeError)
    assert.throws(() => notes.put({ ...note('n1', 1000), createdAt: Number.POSITIVE_INFINITY }), TypeError)
    assert.throws(() => notes.put({ ...note('n1', 1000), createdAt: '1000' as unknown as number }), TypeError)
  })
})

describe('store: delete', () => {
  let store: StoreHandle

  beforeEach(() => {
    store = openStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  test('returns true when a row was removed and false otherwise', () => {
    const notes = store.collection('testNotes')
    notes.put(note('n1', 1000))

    assert.equal(notes.delete('n1'), true)
    assert.equal(notes.delete('n1'), false)
    assert.equal(notes.get('n1'), undefined)
  })

  test('does not delete from other collections', () => {
    const notes = store.collection('testNotes')
    const other = store.collection('testOther')
    notes.put(note('n1', 1000))
    other.put(note('n1', 1000))

    assert.equal(notes.delete('n1'), true)
    assert.equal(other.get('n1')?.id, 'n1')
  })
})

describe('store: list', () => {
  let store: StoreHandle

  beforeEach(() => {
    store = openStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  test('returns all records ordered by createdAt then id ascending', () => {
    const notes = store.collection('testNotes')
    notes.put(note('b', 2000))
    notes.put(note('a', 1000))
    notes.put(note('c', 2000))
    notes.put(note('d', 1000))

    const ids = notes.list().map((r) => r.id)
    assert.deepEqual(ids, ['a', 'd', 'b', 'c'])
  })

  test('breaks createdAt ties by id', () => {
    const notes = store.collection('testNotes')
    notes.put(note('z', 500))
    notes.put(note('a', 500))
    notes.put(note('m', 500))

    assert.deepEqual(notes.list().map((r) => r.id), ['a', 'm', 'z'])
  })

  test('order desc reverses both createdAt and id', () => {
    const notes = store.collection('testNotes')
    notes.put(note('b', 2000))
    notes.put(note('a', 1000))
    notes.put(note('c', 2000))
    notes.put(note('d', 1000))

    const ids = notes.list({ order: 'desc' }).map((r) => r.id)
    assert.deepEqual(ids, ['c', 'b', 'd', 'a'])
  })

  test('filters by scope', () => {
    const notes = store.collection('testNotes')
    notes.put(note('g1', 1000, { scope: 'global' }))
    notes.put(note('a1', 2000, { scope: 'agent:alpha' }))
    notes.put(note('r1', 3000, { scope: 'room:beta' }))

    assert.deepEqual(notes.list({ scope: 'agent:alpha' }).map((r) => r.id), ['a1'])
    assert.deepEqual(notes.list({ scope: 'global' }).map((r) => r.id), ['g1'])
    assert.deepEqual(notes.list({ scope: 'room:beta' }).map((r) => r.id), ['r1'])
  })

  test('filters by after (strictly greater than)', () => {
    const notes = store.collection('testNotes')
    notes.put(note('a', 1000))
    notes.put(note('b', 2000))
    notes.put(note('c', 3000))

    assert.deepEqual(notes.list({ after: 1000 }).map((r) => r.id), ['b', 'c'])
    assert.deepEqual(notes.list({ after: 2000 }).map((r) => r.id), ['c'])
    assert.deepEqual(notes.list({ after: 3000 }).map((r) => r.id), [])
  })

  test('applies limit', () => {
    const notes = store.collection('testNotes')
    notes.put(note('a', 1000))
    notes.put(note('b', 2000))
    notes.put(note('c', 3000))

    assert.deepEqual(notes.list({ limit: 2 }).map((r) => r.id), ['a', 'b'])
    assert.deepEqual(notes.list({ limit: 1, order: 'desc' }).map((r) => r.id), ['c'])
  })

  test('combines scope, after, order and limit', () => {
    const notes = store.collection('testNotes')
    notes.put(note('a', 1000, { scope: 'agent:alpha' }))
    notes.put(note('b', 2000, { scope: 'agent:alpha' }))
    notes.put(note('c', 3000, { scope: 'agent:alpha' }))
    notes.put(note('d', 4000, { scope: 'global' }))

    const ids = notes
      .list({ scope: 'agent:alpha', after: 1000, order: 'desc', limit: 1 })
      .map((r) => r.id)
    assert.deepEqual(ids, ['c'])
  })

  test('rejects invalid limits with RangeError', () => {
    const notes = store.collection('testNotes')
    assert.throws(() => notes.list({ limit: 0 }), RangeError)
    assert.throws(() => notes.list({ limit: -1 }), RangeError)
    assert.throws(() => notes.list({ limit: 1.5 }), RangeError)
  })

  test('does not list records from other collections', () => {
    const notes = store.collection('testNotes')
    const other = store.collection('testOther')
    notes.put(note('n1', 1000))
    other.put(note('o1', 1000))

    assert.deepEqual(notes.list().map((r) => r.id), ['n1'])
    assert.deepEqual(other.list().map((r) => r.id), ['o1'])
  })
})

describe('store: count', () => {
  let store: StoreHandle

  beforeEach(() => {
    store = openStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  test('counts all rows in the collection', () => {
    const notes = store.collection('testNotes')
    assert.equal(notes.count(), 0)
    notes.put(note('a', 1000))
    notes.put(note('b', 2000))
    assert.equal(notes.count(), 2)
  })

  test('counts rows in a scope', () => {
    const notes = store.collection('testNotes')
    notes.put(note('a', 1000, { scope: 'global' }))
    notes.put(note('b', 2000, { scope: 'agent:alpha' }))
    notes.put(note('c', 3000, { scope: 'agent:alpha' }))

    assert.equal(notes.count({ scope: 'agent:alpha' }), 2)
    assert.equal(notes.count({ scope: 'global' }), 1)
    assert.equal(notes.count({ scope: 'room:beta' }), 0)
  })

  test('does not count records from other collections', () => {
    const notes = store.collection('testNotes')
    const other = store.collection('testOther')
    notes.put(note('a', 1000))
    other.put(note('b', 1000))
    other.put(note('c', 2000))

    assert.equal(notes.count(), 1)
    assert.equal(other.count(), 2)
  })
})

describe('store: clear', () => {
  let store: StoreHandle

  beforeEach(() => {
    store = openStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  test('deletes only rows in the given scope and returns the count', () => {
    const notes = store.collection('testNotes')
    notes.put(note('a', 1000, { scope: 'agent:alpha' }))
    notes.put(note('b', 2000, { scope: 'agent:alpha' }))
    notes.put(note('c', 3000, { scope: 'global' }))

    assert.equal(notes.clear('agent:alpha'), 2)
    assert.equal(notes.count(), 1)
    assert.deepEqual(notes.list().map((r) => r.id), ['c'])
  })

  test('returns 0 when nothing matches', () => {
    const notes = store.collection('testNotes')
    notes.put(note('a', 1000, { scope: 'global' }))
    assert.equal(notes.clear('room:beta'), 0)
    assert.equal(notes.count(), 1)
  })

  test('does not clear other collections', () => {
    const notes = store.collection('testNotes')
    const other = store.collection('testOther')
    notes.put(note('a', 1000, { scope: 'global' }))
    other.put(note('b', 1000, { scope: 'global' }))

    assert.equal(notes.clear('global'), 1)
    assert.equal(notes.count(), 0)
    assert.equal(other.count(), 1)
  })
})

describe('store: transaction', () => {
  let store: StoreHandle

  beforeEach(() => {
    store = openStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  test('commits writes and returns the callback value', () => {
    const notes = store.collection('testNotes')
    const result = store.transaction(() => {
      notes.put(note('a', 1000))
      notes.put(note('b', 2000))
      return 'done'
    })

    assert.equal(result, 'done')
    assert.equal(notes.count(), 2)
  })

  test('rolls back and rethrows the same error', () => {
    const notes = store.collection('testNotes')
    notes.put(note('keep', 500))

    const boom = new Error('boom')
    let caught: unknown
    try {
      store.transaction(() => {
        notes.put(note('a', 1000))
        throw boom
      })
    } catch (err) {
      caught = err
    }

    assert.equal(caught, boom)
    assert.equal(notes.count(), 1)
    assert.equal(notes.get('a'), undefined)
    assert.equal(notes.get('keep')?.id, 'keep')
  })

  test('nested transactions run inside the outer transaction', () => {
    const notes = store.collection('testNotes')
    const result = store.transaction(() => {
      notes.put(note('outer', 1000))
      const inner = store.transaction(() => {
        notes.put(note('inner', 2000))
        return 42
      })
      return inner
    })

    assert.equal(result, 42)
    assert.equal(notes.count(), 2)
  })

  test('inner throw caught by outer still commits the outer transaction', () => {
    const notes = store.collection('testNotes')
    const result = store.transaction(() => {
      notes.put(note('outer', 1000))
      try {
        store.transaction(() => {
          notes.put(note('inner', 2000))
          throw new Error('inner-boom')
        })
      } catch {
        // swallowed: outer continues
      }
      notes.put(note('after', 3000))
      return 'ok'
    })

    assert.equal(result, 'ok')
    assert.equal(notes.count(), 3)
    assert.equal(notes.get('inner')?.id, 'inner')
    assert.equal(notes.get('after')?.id, 'after')
  })

  test('outer throw rolls back everything including nested writes', () => {
    const notes = store.collection('testNotes')
    const boom = new Error('outer-boom')

    assert.throws(() => {
      store.transaction(() => {
        notes.put(note('outer', 1000))
        store.transaction(() => {
          notes.put(note('inner', 2000))
        })
        throw boom
      })
    }, (err: unknown) => err === boom)

    assert.equal(notes.count(), 0)
  })
})

describe('store: close', () => {
  test('close is idempotent', () => {
    const store = openStore(':memory:')
    store.close()
    assert.doesNotThrow(() => store.close())
  })

  test('operations after close throw', () => {
    const store = openStore(':memory:')
    const notes = store.collection('testNotes')
    notes.put(note('a', 1000))
    store.close()

    assert.throws(() => notes.get('a'))
    assert.throws(() => notes.put(note('b', 2000)))
    assert.throws(() => notes.delete('a'))
    assert.throws(() => notes.list())
    assert.throws(() => notes.count())
    assert.throws(() => notes.clear('global'))
    assert.throws(() => store.transaction(() => 1))
  })
})

describe('store: persistence and meta', () => {
  test('reopening the same file path sees committed data', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'store.db')

    const first = openStore(file)
    first.collection('testNotes').put(note('a', 1000, { text: 'persisted' }))
    first.close()

    const second = openStore(file)
    const got = second.collection('testNotes').get('a')
    assert.equal(got?.text, 'persisted')
    assert.equal(second.collection('testNotes').count(), 1)
    second.close()
  })

  test('uncommitted transaction writes do not persist across reopen', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'store.db')

    const first = openStore(file)
    const notes = first.collection('testNotes')
    notes.put(note('keep', 500))
    assert.throws(() => {
      first.transaction(() => {
        notes.put(note('gone', 1000))
        throw new Error('nope')
      })
    })
    first.close()

    const second = openStore(file)
    assert.equal(second.collection('testNotes').get('keep')?.id, 'keep')
    assert.equal(second.collection('testNotes').get('gone'), undefined)
    second.close()
  })

  test('meta schema_version is 1', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'store.db')

    const store = openStore(file)
    store.close()

    const db = new DatabaseSync(file)
    try {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
        | { value: string }
        | undefined
      assert.ok(row)
      assert.equal(row.value, '1')
    } finally {
      db.close()
    }
  })

  test('injected now() is written to updated_at', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'store.db')

    let clock = 111
    const store = openStore(file, { now: () => clock })
    store.collection('testNotes').put(note('a', 1000))
    clock = 222
    store.collection('testNotes').put(note('b', 2000))
    store.close()

    const db = new DatabaseSync(file)
    try {
      const rows = db
        .prepare('SELECT id, updated_at FROM records WHERE collection = ? ORDER BY id')
        .all('testNotes')
        .map((r) => ({ ...r }))
      assert.deepEqual(rows, [
        { id: 'a', updated_at: 111 },
        { id: 'b', updated_at: 222 },
      ])
    } finally {
      db.close()
    }
  })

  test('file databases use WAL journal mode', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'store.db')

    const store = openStore(file)
    store.collection('testNotes').put(note('a', 1000))
    store.close()

    const db = new DatabaseSync(file)
    try {
      const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string } | undefined
      assert.ok(row)
      assert.equal(row.journal_mode.toLowerCase(), 'wal')
    } finally {
      db.close()
    }
  })
})
