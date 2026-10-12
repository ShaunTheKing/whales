import { Service, type Context } from 'cordis'
import type { BaseRecord, Collection, Collections, StoreService } from '../contracts/store.ts'
import { openStore, type StoreHandle } from './store.ts'

/** Root `store` service: owns one SQLite handle and closes it when disposed. */
export class Store extends Service implements StoreService {
  private handle: StoreHandle

  constructor(ctx: Context, config: { path: string }) {
    super(ctx, 'store')
    const handle = openStore(config.path)
    this.handle = handle
    ctx.effect(() => () => handle.close(), 'sqlite')
  }

  collection<K extends keyof Collections & string>(name: K): Collection<Collections[K] & BaseRecord> {
    return this.handle.collection(name)
  }

  transaction<T>(fn: () => T): T {
    return this.handle.transaction(fn)
  }
}
