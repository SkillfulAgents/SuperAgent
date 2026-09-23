import { and, eq, like, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { emailIntegrationState } from '../db/schema'

export async function readEmailState<T>(integrationId: string, key: string, schema: z.ZodType<T>): Promise<T | null> {
  const row = await db.select().from(emailIntegrationState).where(and(eq(emailIntegrationState.integrationId, integrationId), eq(emailIntegrationState.key, key))).get()
  if (!row) return null
  try { return schema.parse(JSON.parse(row.value)) } catch { throw new Error('Invalid persisted email state') }
}
export async function writeEmailState<T>(integrationId: string, key: string, schema: z.ZodType<T>, value: T): Promise<void> {
  const serialized = JSON.stringify(schema.parse(value))
  await db.insert(emailIntegrationState).values({ integrationId, key, value: serialized }).onConflictDoUpdate({ target: [emailIntegrationState.integrationId, emailIntegrationState.key], set: { value: serialized } }).run()
}

export async function replaceEmailState(integrationId: string, key: string, before: unknown, after: unknown): Promise<boolean> {
  const rows = await db.update(emailIntegrationState).set({ value: JSON.stringify(after) }).where(and(eq(emailIntegrationState.integrationId, integrationId), eq(emailIntegrationState.key, key), eq(emailIntegrationState.value, JSON.stringify(before)))).returning({ key: emailIntegrationState.key }).all()
  return rows.length === 1
}
export async function deleteEmailState(integrationId: string, key: string): Promise<void> {
  await db.delete(emailIntegrationState).where(and(eq(emailIntegrationState.integrationId, integrationId), eq(emailIntegrationState.key, key))).run()
}

export async function emailThreadRoute(integrationId: string, id: string): Promise<string> {
  const seen = new Set<string>()
  while (!seen.has(id)) {
    seen.add(id)
    const next = await readEmailState(integrationId, `route:${id}`, z.string())
    if (!next) return id
    id = next
  }
  throw new Error('Invalid email thread redirect')
}

export async function pendingEmailReplies(integrationId: string) {
  return db.select({ key: emailIntegrationState.key }).from(emailIntegrationState)
    .where(and(eq(emailIntegrationState.integrationId, integrationId), like(emailIntegrationState.key, 'reply-job:%'),
      sql`COALESCE(json_extract(${emailIntegrationState.value}, '$.retryAfter'), 0) <= ${Date.now()}`))
    .orderBy(sql`COALESCE(json_extract(${emailIntegrationState.value}, '$.retryAfter'), 0)`).limit(5).all()
}
