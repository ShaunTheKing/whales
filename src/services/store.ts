import { DatabaseSync } from 'node:sqlite'
import type { SQLOutputValue } from 'node:sqlite'

import type { BaseRecord, Collection, Collections, ListQuery, StoreService } from '../contracts/store.ts'
import type { Scope } from '../contracts/core.ts'

export interface StoreHandle extends StoreService {
  close(): void
  readonly path: string
}

export interface OpenStoreOptions {
  now?: () => number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, scope TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (collection, id));
CREATE INDEX IF NOT EXISTS records_scope ON records (collection, scope, created_at, id);
`

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateRecord(record: unknown): asserts record is BaseRecord {
  if (!isPlainObject(record)) {
    throw new TypeError('record must be a non-null object')
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new TypeError('record.id must be a non-empty string')
  }
  if (typeof record.scope !== 'string' || record.scope.length === 0) {
    throw new TypeError('record.scope must be a non-empty string')
  }
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) {
    throw new TypeError('record.createdAt must be a finite number')
  }
}

function readData(row: Record<string, SQLOutputValue> | undefined): BaseRecord | undefined {
  if (row === undefined) return undefined
  const data = row.data
  if (typeof data !== 'string') return undefined
  return JSON.parse(data) as BaseRecord
}

export function openStore(path: string, opts?: OpenStoreOptions): StoreHandle {
  const now = opts?.now ?? (() => Date.now())
  const db = new DatabaseSync(path)

  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL')
  }
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1')

  const stmtPut = db.prepare(
    'INSERT INTO records (collection, id, scope, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(collection, id) DO UPDATE SET scope = excluded.scope, created_at = excluded.created_at, ' +
      'updated_at = excluded.updated_at, data = excluded.data',
  )
  const stmtGet = db.prepare('SELECT data FROM records WHERE collection = ? AND id = ?')
  const stmtDelete = db.prepare('DELETE FROM records WHERE collection = ? AND id = ?')
  const stmtCount = db.prepare('SELECT COUNT(*) AS n FROM records WHERE collection = ?')
  const stmtCountScope = db.prepare('SELECT COUNT(*) AS n FROM records WHERE collection = ? AND scope = ?')
  const stmtClear = db.prepare('DELETE FROM records WHERE collection = ? AND scope = ?')

  let closed = false
  let depth = 0

  function assertOpen(): void {
    if (closed) throw new Error('store is closed')
  }

  function makeCollection(name: string): Collection<BaseRecord> {
    return {
      get(id: string): BaseRecord | undefined {
        assertOpen()
        return readData(stmtGet.get(name, id))
      },
      put(record: BaseRecord): BaseRecord {
        assertOpen()
        validateRecord(record)
        stmtPut.run(
          name,
          record.id,
          record.scope,
          record.createdAt,
          now(),
          JSON.stringify(record),
        )
        return record
      },
      delete(id: string): boolean {
        assertOpen()
        const result = stmtDelete.run(name, id)
        return Number(result.changes) > 0
      },
      list(query?: ListQuery): BaseRecord[] {
        assertOpen()
        const clauses = ['collection = ?']
        const params: Array<string | number> = [name]
        if (query?.scope !== undefined) {
          clauses.push('scope = ?')
          params.push(query.scope)
        }
        if (query?.after !== undefined) {
          clauses.push('created_at > ?')
          params.push(query.after)
        }
        const dir = query?.order === 'desc' ? 'DESC' : 'ASC'
        let sql = `SELECT data FROM records WHERE ${clauses.join(' AND ')} ORDER BY created_at ${dir}, id ${dir}`
        if (query?.limit !== undefined) {
          if (!Number.isInteger(query.limit) || query.limit <= 0) {
            throw new RangeError('limit must be a positive integer')
          }
          sql += ' LIMIT ?'
          params.push(query.limit)
        }
        const rows = db.prepare(sql).all(...params)
        const out: BaseRecord[] = []
        for (const row of rows) {
          const record = readData(row)
          if (record !== undefined) out.push(record)
        }
        return out
      },
      count(query?: Pick<ListQuery, 'scope'>): number {
        assertOpen()
        const row =
          query?.scope !== undefined ? stmtCountScope.get(name, query.scope) : stmtCount.get(name)
        const n = row?.n
        return typeof n === 'number' ? n : Number(n ?? 0)
      },
      clear(scope: Scope): number {
        assertOpen()
        const result = stmtClear.run(name, scope)
        return Number(result.changes)
      },
    }
  }

  const cache = new Map<string, Collection<BaseRecord>>()

  const handle: StoreHandle = {
    path,
    collection<K extends keyof Collections & string>(name: K): Collection<Collections[K] & BaseRecord> {
      assertOpen()
      let collection = cache.get(name)
      if (collection === undefined) {
        collection = makeCollection(name)
        cache.set(name, collection)
      }
      return collection as unknown as Collection<Collections[K] & BaseRecord>
    },
    transaction<T>(fn: () => T): T {
      assertOpen()
      if (depth > 0) {
        return fn()
      }
      depth += 1
      db.exec('BEGIN')
      try {
        const result = fn()
        if (typeof (result as { then?: unknown } | null | undefined)?.then === 'function') {
          db.exec('ROLLBACK')
          throw new TypeError('transaction callback must be synchronous')
        }
        db.exec('COMMIT')
        return result
      } catch (err) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // already rolled back
        }
        throw err
      } finally {
        depth -= 1
      }
    },
    close(): void {
      if (closed) return
      closed = true
      db.close()
    },
  }

  return handle
}
