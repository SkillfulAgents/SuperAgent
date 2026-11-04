/**
 * The deployment's small host records (settings, tenant id, auth secret, …)
 * as rows of the `app_records` table: one JSON value per key, with a revision
 * for conditional writes.
 *
 * There is no interactive transaction on the drivers the app targets, so
 * every write is one conditional statement whose change count is the answer:
 * an insert that does nothing when the key exists, or an update that applies
 * only while the row still has the revision the writer read. A writer that
 * loses re-reads and decides again. Reads go to the database every time;
 * nothing here keeps a copy between calls, so a write committed by another
 * process is what the next read returns.
 */
import { and, eq, gte, lt } from 'drizzle-orm'
import type { AppDatabase } from '@shared/lib/db'
import { changesOf } from '@shared/lib/db/batch'
import { appRecords } from '@shared/lib/db/schema'

/** A stored value and the revision it was read at. */
export interface StoredRecord {
  /** The JSON text as stored; parse it with the key's schema. */
  readonly value: string
  /** 1 after the insert, one more after every write. */
  readonly revision: number
}

export interface AppRecordStore {
  read(key: string): Promise<StoredRecord | null>
  /** Every record whose key starts with `prefix`. */
  list(prefix: string): Promise<Array<StoredRecord & { key: string }>>
  /** Insert `value` at revision 1 unless the key exists. True when this call inserted it. */
  insertIfAbsent(key: string, value: string): Promise<boolean>
  /** Write `value` if the record is still at `revision`. True when this call wrote it. */
  compareAndSet(key: string, revision: number, value: string): Promise<boolean>
  delete(key: string): Promise<void>
}

/** The statements the store issues; the global handle and a data migration's handle both qualify. */
export type AppRecordDb = Pick<AppDatabase, 'select' | 'insert' | 'update' | 'delete'>

/** The store on the app database, on whichever driver opened it. */
export function dbAppRecordStore(db: AppRecordDb): AppRecordStore {
  return {
    async read(key) {
      const row = await db
        .select({ value: appRecords.value, revision: appRecords.revision })
        .from(appRecords)
        .where(eq(appRecords.key, key))
        .get()
      return row ?? null
    },
    async list(prefix) {
      return db
        .select({ key: appRecords.key, value: appRecords.value, revision: appRecords.revision })
        .from(appRecords)
        // A key range rather than LIKE: LIKE folds ASCII case and treats _ as a wildcard.
        .where(and(gte(appRecords.key, prefix), lt(appRecords.key, `${prefix}\u{10FFFF}`)))
        .all()
    },
    async insertIfAbsent(key, value) {
      const result = await db
        .insert(appRecords)
        .values({ key, value, revision: 1, updatedAt: new Date() })
        .onConflictDoNothing()
        .run()
      return changesOf(result) > 0
    },
    async compareAndSet(key, revision, value) {
      const result = await db
        .update(appRecords)
        .set({ value, revision: revision + 1, updatedAt: new Date() })
        .where(and(eq(appRecords.key, key), eq(appRecords.revision, revision)))
        .run()
      return changesOf(result) > 0
    },
    async delete(key) {
      await db.delete(appRecords).where(eq(appRecords.key, key)).run()
    },
  }
}
