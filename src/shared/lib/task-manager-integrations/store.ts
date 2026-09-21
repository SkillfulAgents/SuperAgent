import { and, asc, desc, eq, inArray, like, notExists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { changesOf, insertWhere } from '../db/batch'
import { db } from '../db'
import { integrationTaskEvents } from '../db/schema'
import type { TaskEvent } from './types'
import { parseTaskJson, taskEventSchema, taskFailureNoticeSchema } from './schemas'

export type StoredTaskEvent = typeof integrationTaskEvents.$inferSelect
const activeStatuses = ['running', 'awaiting_input', 'responding'] as const

export async function enqueueTaskEvent(integrationId: string, event: TaskEvent): Promise<boolean> {
  const now = new Date()
  return changesOf(await insertWhere(integrationTaskEvents, {
    id: crypto.randomUUID(), integrationId, externalEventId: event.id,
    taskId: event.taskId, interactionId: event.interactionId, eventJson: JSON.stringify(taskEventSchema.parse(event)),
    status: event.kind === 'context' ? 'context' : 'queued', createdAt: now, updatedAt: now,
  }, notExists(stopsFor(integrationId, event))).onConflictDoNothing().run()) > 0
}
export function readTaskEvent(row: Pick<StoredTaskEvent, 'eventJson'>): TaskEvent { return parseTaskJson(taskEventSchema, row.eventJson) }
export async function getTaskEvent(id: string): Promise<StoredTaskEvent | undefined> {
  return await db.select().from(integrationTaskEvents).where(eq(integrationTaskEvents.id, id)).get()
}
export async function activeTaskEvent(integrationId: string, taskId: string): Promise<StoredTaskEvent | undefined> {
  return await db.select().from(integrationTaskEvents).where(and(
    eq(integrationTaskEvents.integrationId, integrationId), eq(integrationTaskEvents.taskId, taskId),
    inArray(integrationTaskEvents.status, [...activeStatuses]),
  )).orderBy(asc(integrationTaskEvents.createdAt)).get()
}
export async function pendingTaskEvents(integrationId: string): Promise<StoredTaskEvent[]> {
  return await db.select().from(integrationTaskEvents).where(and(
    eq(integrationTaskEvents.integrationId, integrationId),
    inArray(integrationTaskEvents.status, ['queued', ...activeStatuses]),
  )).orderBy(asc(integrationTaskEvents.createdAt)).all()
}
export async function claimTaskEvent(id: string): Promise<StoredTaskEvent | undefined> {
  const active = alias(integrationTaskEvents, 'active_task')
  // The driver claims the queued row only if this issue has no active turn.
  return await db.update(integrationTaskEvents).set({ status: 'running', dispatchAttempts: sql`${integrationTaskEvents.dispatchAttempts} + 1`, updatedAt: new Date() }).where(and(
    eq(integrationTaskEvents.id, id), eq(integrationTaskEvents.status, 'queued'),
    sql`(${integrationTaskEvents.dispatchAttempts} = 0 or ${integrationTaskEvents.updatedAt} + 30000 * ${integrationTaskEvents.dispatchAttempts} <= ${Date.now()})`,
    notExists(db.select({ id: active.id }).from(active).where(and(
      eq(active.integrationId, integrationTaskEvents.integrationId), eq(active.taskId, integrationTaskEvents.taskId),
      inArray(active.status, [...activeStatuses]),
    ))),
  )).returning().get()
}

export async function updateTaskEvent(id: string, patch: Partial<Pick<StoredTaskEvent,
  'status' | 'sessionId' | 'responseText' | 'publicationJson' | 'publishedId' | 'inputRequestJson'>>): Promise<void> {
  await db.update(integrationTaskEvents).set({ ...patch, updatedAt: new Date() }).where(eq(integrationTaskEvents.id, id)).run()
}
/** A late answer cannot reopen a finished, cancelled, or different request. */
export async function resumeTaskInput(id: string, requestId: string): Promise<void> {
  await db.update(integrationTaskEvents).set({ status: 'running', inputRequestJson: null, updatedAt: new Date() }).where(and(
    eq(integrationTaskEvents.id, id), eq(integrationTaskEvents.status, 'awaiting_input'),
    sql`json_extract(${integrationTaskEvents.inputRequestJson}, '$.id') = ${requestId}`,
  )).run()
}

export async function taskContextUpdates(integrationId: string, taskId: string): Promise<TaskEvent[]> {
  return (await db.select().from(integrationTaskEvents).where(and(
    eq(integrationTaskEvents.integrationId, integrationId), eq(integrationTaskEvents.taskId, taskId),
    eq(integrationTaskEvents.status, 'context'),
  )).orderBy(desc(integrationTaskEvents.createdAt)).limit(20).all()).reverse().map(readTaskEvent)
}

/** Shared SQL predicate: acceptance fences cancellation in the INSERT itself. */
function stopsFor(integrationId: string, event: TaskEvent) {
  const stops = alias(integrationTaskEvents, 'task_stops')
  return db.select({ id: stops.id }).from(stops).where(and(
    eq(stops.integrationId, integrationId), eq(stops.taskId, event.taskId),
    like(stops.externalEventId, 'stop:%'),
    sql`(${stops.interactionId} = '' or ${stops.interactionId} = ${event.interactionId})`,
    sql`julianday(json_extract(${stops.eventJson}, '$.timestamp')) >= julianday(${event.timestamp})`,
  )).limit(1)
}
export async function wasStopped(integrationId: string, event: TaskEvent): Promise<boolean> {
  return !!await stopsFor(integrationId, event).get()
}

export async function findTaskEvent(integrationId: string, externalEventId: string): Promise<StoredTaskEvent | undefined> {
  return await db.select().from(integrationTaskEvents).where(and(
    eq(integrationTaskEvents.integrationId, integrationId), eq(integrationTaskEvents.externalEventId, externalEventId),
  )).get()
}

/** Include accepted work that has not created its runtime session yet. */
export async function taskEventHistory(integrationId: string): Promise<StoredTaskEvent[]> {
  return await db.select().from(integrationTaskEvents).where(eq(integrationTaskEvents.integrationId, integrationId)).orderBy(asc(integrationTaskEvents.createdAt)).all()
}

/** Late completion must not resurrect a cancelled or already-finished run. */
export async function finishTaskEvent(id: string, status: 'complete' | 'failed'): Promise<void> {
  await db.update(integrationTaskEvents).set({ status, inputRequestJson: null, publicationJson: null, responseText: null, updatedAt: new Date() })
    .where(and(eq(integrationTaskEvents.id, id), inArray(integrationTaskEvents.status, [...activeStatuses]))).run()
}

/** Session binding and review delivery may race cancellation or completion. */
export async function updateActiveTaskEvent(id: string, patch: Partial<Pick<StoredTaskEvent,
  'status' | 'sessionId' | 'inputRequestJson'>>): Promise<void> {
  await db.update(integrationTaskEvents).set({ ...patch, updatedAt: new Date() })
    .where(and(eq(integrationTaskEvents.id, id), inArray(integrationTaskEvents.status, ['running', 'awaiting_input']))).run()
}

/** Retry only failures known to precede execution. The conditional write fences
 * cancellation/completion and persists attempts across connector rebuilds. */
export async function failTaskDispatch(id: string, body: string, retryable: boolean): Promise<StoredTaskEvent | undefined> {
  const retry = sql`${retryable ? 1 : 0} and ${integrationTaskEvents.sessionId} is null and ${integrationTaskEvents.dispatchAttempts} < 3`
  const notice = JSON.stringify(taskFailureNoticeSchema.parse({ kind: 'failure_notice', id, body }))
  return await db.update(integrationTaskEvents).set({
    status: sql`case when ${retry} then 'queued' else 'responding' end`,
    publicationJson: sql`case when ${retry} then null else ${notice} end`,
    inputRequestJson: null, updatedAt: new Date(),
  }).where(and(eq(integrationTaskEvents.id, id), inArray(integrationTaskEvents.status, ['running', 'awaiting_input']))).returning().get()
}

export const MAX_FAILURE_NOTICE_ATTEMPTS = 3

/** Claim a publication attempt before the network call, including across restarts.
 * Comparing the publication fences concurrent recovery and cancellation. */
export async function claimTaskFailureNotice(row: StoredTaskEvent): Promise<StoredTaskEvent | undefined> {
  const notice = parseTaskJson(taskFailureNoticeSchema, row.publicationJson ?? '')
  if (notice.attempts >= MAX_FAILURE_NOTICE_ATTEMPTS) return undefined
  const publicationJson = JSON.stringify(taskFailureNoticeSchema.parse({ ...notice, attempts: notice.attempts + 1 }))
  return await db.update(integrationTaskEvents).set({ publicationJson, updatedAt: new Date() }).where(and(
    eq(integrationTaskEvents.id, row.id), eq(integrationTaskEvents.status, 'responding'),
    eq(integrationTaskEvents.publicationJson, row.publicationJson!),
    sql`(${notice.attempts} = 0 or ${integrationTaskEvents.updatedAt} + 30000 <= ${Date.now()})`,
  )).returning().get()
}

/** Restore thread participation from accepted requests, without fetching Linear history. */
export async function taskParticipation(integrationId: string): Promise<Map<string, Set<string>>> {
  const rows = await db.selectDistinct({ taskId: integrationTaskEvents.taskId,
    root: sql<string | null>`json_extract(${integrationTaskEvents.eventJson}, '$.replyTarget.commentId')`,
  }).from(integrationTaskEvents).where(and(eq(integrationTaskEvents.integrationId, integrationId),
    sql`json_extract(${integrationTaskEvents.eventJson}, '$.kind') in ('invocation', 'status')`,
  )).all()
  const issues = new Map<string, Set<string>>()
  for (const row of rows) {
    const threads = issues.get(row.taskId) ?? new Set<string>()
    if (row.root) threads.add(row.root)
    issues.set(row.taskId, threads)
  }
  return issues
}
