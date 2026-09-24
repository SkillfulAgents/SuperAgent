import { and, eq, inArray, lte, sql, asc, or } from 'drizzle-orm'
import { db } from '../db'
import { batch, changesOf, insertWhere } from '../db/batch'
import { chatIntegrations, chatIntegrationSessions, integrationDeliveries as rows } from '../db/schema'
import { parseDeliveryEnvelope } from './delivery-schema'
import type { IntegrationInputEvent, IntegrationRoute } from './types'

export type DeliveryRecord = typeof rows.$inferSelect
const waiting = () => or(eq(rows.state, 'pending'), and(eq(rows.state, 'sending'), sql`${rows.owner} is null`), eq(rows.noticeState, 'pending'))
const unfinished = ['pending', 'preparing', 'sending'] as const
const runnable = () => sql`exists (select 1 from ${chatIntegrations} where ${chatIntegrations.id} = ${rows.integrationId} and ${chatIntegrations.status} in ('active', 'error'))`
export const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export const deliveryStore = {
  async accept(integrationId: string, event: IntegrationInputEvent, route: IntegrationRoute) {
    // Normalize Dates and optional fields at the boundary, then validate the JSON
    // that will actually survive a restart (no functions, buffers or class state).
    const envelope = parseDeliveryEnvelope(JSON.stringify({ event, route }))
    const now = new Date()
    const id = crypto.randomUUID()
    const result = await insertWhere(rows, { id, integrationId, externalId: route.externalId, eventId: event.id,
      envelope: JSON.stringify(envelope), nextAttemptAt: now, createdAt: now, updatedAt: now },
    sql`exists (select 1 from ${chatIntegrations} where ${chatIntegrations.id} = ${integrationId} and ${chatIntegrations.status} in ('active', 'error'))`)
      .onConflictDoNothing().run()
    return changesOf(result) > 0
  },
  async due(availableIds: readonly string[]) {
    if (!availableIds.length) return []
    return db.select().from(rows).where(and(runnable(), inArray(rows.integrationId, [...availableIds]), waiting()))
      // Bursts can share both timestamps. Use database insertion order to break
      // that tie; the random delivery UUID is an identity, not an ordering key.
      .orderBy(asc(rows.nextAttemptAt), asc(rows.createdAt), asc(sql`${rows}.rowid`)).limit(100).all()
  },
  async nextDue(availableIds?: readonly string[]) {
    if (availableIds && !availableIds.length) return undefined
    return db.select({ at: rows.nextAttemptAt }).from(rows).where(and(runnable(), availableIds ? inArray(rows.integrationId, [...availableIds]) : undefined, waiting()))
      .orderBy(asc(rows.nextAttemptAt)).limit(1).get()
  },
  async ownsInput(id: string, owner: string) {
    return !!await db.select({ id: rows.id }).from(rows).where(and(eq(rows.id, id), eq(rows.owner, owner),
      inArray(rows.state, ['preparing', 'sending']), runnable())).get()
  },
  async ownsNotice(id: string, owner: string) {
    return !!await db.select({ id: rows.id }).from(rows).where(and(eq(rows.id, id), eq(rows.owner, owner),
      eq(rows.noticeState, 'sending'), sql`${rows.state} != 'cancelled'`, runnable())).get()
  },
  async claim(row: DeliveryRecord, owner: string, notice: boolean) {
    const result = await db.update(rows).set(notice
      ? { noticeState: 'sending', noticeAttempts: sql`${rows.noticeAttempts} + 1`, owner, updatedAt: new Date() }
      : { state: 'preparing', attempts: sql`${rows.attempts} + 1`, owner, updatedAt: new Date() })
      .where(and(eq(rows.id, row.id), runnable(), notice ? eq(rows.noticeState, 'pending') : eq(rows.state, 'pending'))).run()
    return changesOf(result) > 0
  },
  async change(id: string, owner: string, patch: Partial<typeof rows.$inferInsert>) {
    const result = await db.update(rows).set({ ...patch, updatedAt: new Date() })
      .where(and(eq(rows.id, id), eq(rows.owner, owner), sql`${rows.state} != 'cancelled'`, runnable())).run()
    return changesOf(result) > 0
  },
  async handoff(id: string, owner: string, sessionId?: string) {
    const result = await db.update(rows).set({ state: 'sending', sessionId, updatedAt: new Date() })
      .where(and(eq(rows.id, id), eq(rows.owner, owner), eq(rows.state, 'preparing'), runnable())).run()
    return changesOf(result) > 0
  },
  async cancel(integrationId: string, externalId?: string, exceptId?: string) {
    await db.update(rows).set({ state: 'cancelled', noticeState: 'none', owner: null, envelope: null, updatedAt: new Date() })
      .where(and(eq(rows.integrationId, integrationId), externalId === undefined ? undefined : eq(rows.externalId, externalId),
        exceptId ? sql`${rows.id} != ${exceptId}` : undefined,
        or(inArray(rows.state, unfinished), inArray(rows.noticeState, ['pending', 'sending'])))).run()
  },
  async cancelSession(rowId: string) {
    await db.update(rows).set({ state: 'cancelled', noticeState: 'none', owner: null, envelope: null, updatedAt: new Date() })
      .where(and(or(inArray(rows.state, unfinished), inArray(rows.noticeState, ['pending', 'sending'])),
        sql`exists (select 1 from ${chatIntegrationSessions} where ${chatIntegrationSessions.id} = ${rowId}
          and ${chatIntegrationSessions.integrationId} = ${rows.integrationId} and ${chatIntegrationSessions.externalChatId} = ${rows.externalId})`)).run()
  },
  async recover() {
    // Only host startup resets preparation leases. A possibly accepted send is
    // left as 'sending' for reconciliation, never returned to the dispatch queue.
    await batch([
      db.update(rows).set({ state: 'pending', owner: null }).where(eq(rows.state, 'preparing')),
      db.update(rows).set({ noticeState: 'pending', owner: null }).where(eq(rows.noticeState, 'sending')),
      db.update(rows).set({ owner: null }).where(eq(rows.state, 'sending')),
      db.update(rows).set({ state: 'cancelled', noticeState: 'none', owner: null, envelope: null, updatedAt: new Date() })
        .where(and(sql`not (${runnable()})`, or(inArray(rows.state, unfinished), inArray(rows.noticeState, ['pending', 'sending'])))),
    ])
    await this.prune()
  },
  async prune() {
    await db.delete(rows).where(and(lte(rows.updatedAt, new Date(Date.now() - DELIVERY_RETENTION_MS)),
      inArray(rows.state, ['delivered', 'failed', 'uncertain', 'cancelled']), inArray(rows.noticeState, ['none', 'sent', 'failed']))).run()
  },
  async adopt(row: DeliveryRecord, owner: string) {
    const result = await db.update(rows).set({ owner }).where(and(eq(rows.id, row.id), eq(rows.state, 'sending'), sql`${rows.owner} is null`, runnable())).run()
    return changesOf(result) > 0
  },
}
