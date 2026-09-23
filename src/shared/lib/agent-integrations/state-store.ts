import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { integrationState as rows } from '../db/schema'
import { changesOf } from '../db/batch'

const stateAddress = z.object({ integrationId: z.string().min(1), key: z.string().min(1).max(512) })
const writeOptions = z.object({ availableAt: z.number().int().nonnegative().nullable().optional() })
const listOptions = z.object({ prefix: z.string().max(512).default(''), limit: z.number().int().min(1).max(1000).default(100), readyBefore: z.number().int().nonnegative().optional() })
type WriteOptions = z.infer<typeof writeOptions>

/** Framework-owned persistence. Providers supply schemas; SQL never inspects their payloads. */
export async function readIntegrationState<T>(integrationId: string, key: string, schema: z.ZodType<T>): Promise<T | null> {
  stateAddress.parse({ integrationId, key })
  const row = await db.select({ value: rows.value }).from(rows).where(and(eq(rows.integrationId, integrationId), eq(rows.key, key))).get()
  if (!row) return null
  try { return schema.parse(JSON.parse(row.value)) }
  catch { throw new Error('Invalid persisted integration state') }
}
export async function writeIntegrationState<T>(integrationId: string, key: string, schema: z.ZodType<T>, value: T, options: WriteOptions = {}): Promise<void> {
  stateAddress.parse({ integrationId, key })
  const serialized = JSON.stringify(schema.parse(value))
  const availableAt = writeOptions.parse(options).availableAt ?? null
  await db.insert(rows).values({ integrationId, key, value: serialized, availableAt })
    .onConflictDoUpdate({ target: [rows.integrationId, rows.key], set: { value: serialized, availableAt } }).run()
}
/** Atomic claim/update, using validated values on both sides. */
export async function replaceIntegrationState<T>(integrationId: string, key: string, schema: z.ZodType<T>, before: T, after: T, options: WriteOptions = {}): Promise<boolean> {
  stateAddress.parse({ integrationId, key })
  const value = JSON.stringify(schema.parse(after))
  const previous = JSON.stringify(schema.parse(before))
  const availableAt = writeOptions.parse(options).availableAt ?? null
  const result = await db.update(rows).set({ value, availableAt })
    .where(and(eq(rows.integrationId, integrationId), eq(rows.key, key), eq(rows.value, previous))).run()
  return changesOf(result) === 1
}
export async function deleteIntegrationState(integrationId: string, key: string): Promise<void> {
  stateAddress.parse({ integrationId, key })
  await db.delete(rows).where(and(eq(rows.integrationId, integrationId), eq(rows.key, key))).run()
}
/** Bounded key discovery; literal prefixes cannot expand into SQL wildcards. */
export async function listIntegrationStateKeys(integrationId: string, input: z.input<typeof listOptions> = {}) {
  z.string().min(1).parse(integrationId)
  const { prefix, limit, readyBefore } = listOptions.parse(input)
  return db.select({ key: rows.key }).from(rows).where(and(
    eq(rows.integrationId, integrationId),
    sql`substr(${rows.key}, 1, ${prefix.length}) = ${prefix}`,
    readyBefore === undefined ? undefined : lte(rows.availableAt, readyBefore),
  )).orderBy(asc(rows.availableAt), asc(rows.key)).limit(limit).all()
}
