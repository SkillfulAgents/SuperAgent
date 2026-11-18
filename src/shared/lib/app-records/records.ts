/**
 * The deployment's small host records (settings, tenant id, auth secret, …)
 * as rows of the `app_records` table: one JSON value per key, with a revision
 * for conditional writes, parsed with the key's Zod schema on every read and
 * write.
 *
 * Every operation runs against the app database (the `db` handle the entry
 * point opened with `openDatabase()`), or against the handle it is given: a
 * data migration's, or a test's second connection. There is no other store
 * and nothing kept between calls, so a write committed by another process is
 * what the next read returns.
 *
 * There is no interactive transaction on the drivers the app targets, so
 * every write is one conditional statement whose change count is the answer:
 * an insert that does nothing when the key exists, or an update that applies
 * only while the row still has the revision the writer read. A writer that
 * loses re-reads and decides again.
 */
import { and, eq, gte, lt } from 'drizzle-orm'
import type { z } from 'zod'
import { db as appDb, type AppDatabase } from '@shared/lib/db'
import { changesOf } from '@shared/lib/db/batch'
import { appRecords } from '@shared/lib/db/schema'
import { InvalidAppRecordError } from './errors'

/** The statements records issue; the app database and a data migration's handle both qualify. */
export type RecordDb = Pick<AppDatabase, 'select' | 'insert' | 'update' | 'delete'>

/** A stored value as stored (JSON text) and the revision it was read at. */
export interface StoredRecord {
  readonly value: string
  /** 1 after the insert, one more after every write. */
  readonly revision: number
}

export { InvalidAppRecordError } from './errors'

// ── Stored text ─────────────────────────────────────────────────────────────

/** The stored text and revision of `key`; null when absent. */
export async function readStoredRecord(key: string, db: RecordDb = appDb): Promise<StoredRecord | null> {
  const row = await db
    .select({ value: appRecords.value, revision: appRecords.revision })
    .from(appRecords)
    .where(eq(appRecords.key, key))
    .get()
  return row ?? null
}

/** Every stored record whose key starts with `prefix`. */
export async function listStoredRecords(prefix: string, db: RecordDb = appDb): Promise<Array<StoredRecord & { key: string }>> {
  return db
    .select({ key: appRecords.key, value: appRecords.value, revision: appRecords.revision })
    .from(appRecords)
    // A key range rather than LIKE: LIKE folds ASCII case and treats _ as a wildcard.
    .where(and(gte(appRecords.key, prefix), lt(appRecords.key, `${prefix}\u{10FFFF}`)))
    .all()
}

/** Insert `value` (stored text) at revision 1 unless the key exists. True when this call inserted it. */
export async function insertRecordIfAbsent(key: string, value: string, db: RecordDb = appDb): Promise<boolean> {
  const result = await db
    .insert(appRecords)
    .values({ key, value, revision: 1, updatedAt: new Date() })
    .onConflictDoNothing()
    .run()
  return changesOf(result) > 0
}

/** Write `value` (stored text) if the record is still at `revision`. True when this call wrote it. */
export async function compareAndSetRecord(key: string, revision: number, value: string, db: RecordDb = appDb): Promise<boolean> {
  const result = await db
    .update(appRecords)
    .set({ value, revision: revision + 1, updatedAt: new Date() })
    .where(and(eq(appRecords.key, key), eq(appRecords.revision, revision)))
    .run()
  return changesOf(result) > 0
}

export async function deleteRecord(key: string, db: RecordDb = appDb): Promise<void> {
  await db.delete(appRecords).where(eq(appRecords.key, key)).run()
}

// ── Typed values ────────────────────────────────────────────────────────────

/** Parse a stored value with its schema; throws InvalidAppRecordError. */
export function parseRecordValue<S extends z.ZodType>(key: string, stored: string, schema: S): z.output<S> {
  let json: unknown
  try {
    json = JSON.parse(stored)
  } catch (cause) {
    throw new InvalidAppRecordError(key, 'not JSON', { cause })
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new InvalidAppRecordError(key, parsed.error.message, { cause: parsed.error })
  return parsed.data
}

/** Validate a value against its schema and serialize it for storage. */
export function serializeRecordValue<S extends z.ZodType>(key: string, value: z.input<S>, schema: S): string {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new InvalidAppRecordError(key, `refusing to write: ${parsed.error.message}`, { cause: parsed.error })
  }
  const json = JSON.stringify(parsed.data)
  if (json === undefined) throw new InvalidAppRecordError(key, 'refusing to write a value with no JSON form')
  return json
}

export interface ReadRecord<T> {
  readonly value: T
  readonly revision: number
}

/** Read and parse a record; null when absent. A database error or an invalid value throws. */
export async function readRecord<S extends z.ZodType>(
  key: string,
  schema: S,
  db: RecordDb = appDb,
): Promise<ReadRecord<z.output<S>> | null> {
  const stored = await readStoredRecord(key, db)
  if (!stored) return null
  return { value: parseRecordValue(key, stored.value, schema), revision: stored.revision }
}

/**
 * The record's value, created by `create` when the key is absent. Concurrent
 * first uses converge: each inserts only if absent and then returns what the
 * database holds, so a caller whose insert lost returns the winner's value,
 * never its own discarded candidate. A database error or an invalid stored
 * value throws: neither is evidence that the record is absent.
 */
export async function getOrCreateRecord<S extends z.ZodType>(
  key: string,
  schema: S,
  create: () => z.input<S>,
  db: RecordDb = appDb,
): Promise<z.output<S>> {
  const existing = await readRecord(key, schema, db)
  if (existing) return existing.value
  await insertRecordIfAbsent(key, serializeRecordValue(key, create(), schema), db)
  const committed = await readRecord(key, schema, db)
  if (!committed) throw new Error(`App record "${key}" was created and then disappeared before it could be read back`)
  return committed.value
}
