/**
 * The app's database handle.
 *
 * `openDatabase()` is the entry point's first boot step; after it `getDb()`
 * returns the handle and `db` forwards to it. Nothing here names a driver:
 * the choice lives in `open-database.ts`, the driver packages are imported
 * only under `drivers/`.
 */
import type { SyncAppDatabase } from './drivers/types'
import { getDb } from './open-database'

export { closeDatabase, getDb, isDatabaseOpen, openDatabase } from './open-database'
export type { AppDatabase, DatabaseDriver, SyncAppDatabase } from './drivers/types'

/**
 * The handle `getDb()` returns, reached through a proxy so importers bind to
 * the module, not to one open. Typed as the synchronous view until every
 * statement is awaited (SUP-865); a run result is opaque, so a change count
 * is read with `changesOf()` from `./batch`.
 */
export const db = new Proxy({} as SyncAppDatabase, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver)
  },
})
