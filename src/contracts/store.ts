import type { Scope } from './core.ts'

/** Every persisted record has these fields. */
export interface BaseRecord {
  id: string
  scope: Scope
  /** ms since epoch. */
  createdAt: number
}

/**
 * Collection name → record type. Each contract file adds its own entries via declaration merging:
 *   declare module './store.ts' { interface Collections { rules: Rule } }
 */
export interface Collections {}

export interface ListQuery {
  scope?: Scope
  /** Ordered by createdAt, then id. Default `asc`. */
  order?: 'asc' | 'desc'
  limit?: number
  /** Only records with createdAt strictly greater than this. */
  after?: number
}

export interface Collection<T extends BaseRecord> {
  get(id: string): T | undefined
  /** Insert or replace by id. `scope` and `createdAt` are stored as indexed columns. */
  put(record: T): T
  delete(id: string): boolean
  list(query?: ListQuery): T[]
  count(query?: Pick<ListQuery, 'scope'>): number
  /** Delete every record in a scope. Returns the number removed. */
  clear(scope: Scope): number
}

export interface StoreService {
  collection<K extends keyof Collections & string>(name: K): Collection<Collections[K] & BaseRecord>
  /** Runs `fn` in a single SQLite transaction (synchronous; node:sqlite is sync). */
  transaction<T>(fn: () => T): T
  /** Writes a consistent copy of the database to `dest` (a path that must not exist yet). */
  backupTo(dest: string): void
}

declare module 'cordis' {
  interface Context {
    store: StoreService
  }
}
