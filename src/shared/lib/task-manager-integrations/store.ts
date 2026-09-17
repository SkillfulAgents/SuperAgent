import { and, asc, desc, eq, inArray, like, notExists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { changesOf } from '../db/batch'
import { db } from '../db'
import { integrationTaskEvents } from '../db/schema'
import type { TaskEvent, TaskPublication } from './types'
import { parseTaskJson, taskEventSchema, taskPublicationSchema } from './schemas'

export type StoredTaskEvent = typeof integrationTaskEvents.$inferSelect
const activeStatuses = ['running', 'awaiting_input', 'responding'] as const

export function enqueueTaskEvent(integrationId: string, event: TaskEvent): boolean {
  const now = new Date()
  return changesOf(db.insert(integrationTaskEvents).values({
    id: crypto.randomUUID(), integrationId, externalEventId: event.id,
    taskId: event.taskId, interactionId: event.interactionId, eventJson: JSON.stringify(taskEventSchema.parse(event)),
    status: event.kind === 'context' ? 'context' : 'queued', createdAt: now, updatedAt: now,
  }).onConflictDoNothing().run()) > 0
}
export function readTaskEvent(row: Pick<StoredTaskEvent, 'eventJson'>): TaskEvent { return parseTaskJson(taskEventSchema, row.eventJson) }
export function getTaskEvent(id: string): StoredTaskEvent | undefined {
  return db.select().from(integrationTaskEvents).where(eq(integrationTaskEvents.id, id)).get()
}
export function activeTaskEvent(integrationId: string, taskId: string): StoredTaskEvent | undefined {
  return db.select().from(integrationTaskEvents).where(and(
    eq(integrationTaskEvents.integrationId, integrationId), eq(integrationTaskEvents.taskId, taskId),
    inArray(integrationTaskEvents.status, [...activeStatuses]),
  )).orderBy(asc(integrationTaskEvents.createdAt)).get()
}
export function pendingTaskEvents(integrationId: string): StoredTaskEvent[] {
  return db.select().from(integrationTaskEvents).where(and(
    eq(integrationTaskEvents.integrationId, integrationId),
    inArray(integrationTaskEvents.status, ['queued', ...activeStatuses]),
  )).orderBy(asc(integrationTaskEvents.createdAt)).all()
}
export function claimTaskEvent(id: string): StoredTaskEvent | undefined {
  const active = alias(integrationTaskEvents, 'active_task')
  // The driver claims the queued row only if this issue has no active turn.
  return db.update(integrationTaskEvents).set({ status: 'running', updatedAt: new Date() }).where(and(
    eq(integrationTaskEvents.id, id), eq(integrationTaskEvents.status, 'queued'),
    notExists(db.select({ id: active.id }).from(active).where(and(
      eq(active.integrationId, integrationTaskEvents.integrationId), eq(active.taskId, integrationTaskEvents.taskId),
      inArray(active.status, [...activeStatuses]),
    ))),
  )).returning().get()
}

export function updateTaskEvent(id: string, patch: Partial<Pick<StoredTaskEvent,
  'status' | 'sessionId' | 'responseText' | 'publicationJson' | 'publishedId' | 'inputRequestJson'>>): void {
  db.update(integrationTaskEvents).set({ ...patch, updatedAt: new Date() }).where(eq(integrationTaskEvents.id, id)).run()
}
/** A late answer cannot reopen a finished, cancelled, or different request. */
export function resumeTaskInput(id: string, requestId: string): void {
  db.update(integrationTaskEvents).set({ status: 'running', inputRequestJson: null, updatedAt: new Date() }).where(and(
    eq(integrationTaskEvents.id, id), eq(integrationTaskEvents.status, 'awaiting_input'),
    sql`json_extract(${integrationTaskEvents.inputRequestJson}, '$.id') = ${requestId}`,
  )).run()
}

/** Keep stream deltas inside SQLite: no full draft SELECT/JS copy per token. */
export function writeTaskResponse(integrationId: string, taskId: string, sessionId: string, eventId: string | undefined, text: string, append: boolean): void {
  db.update(integrationTaskEvents).set({
    responseText: append ? sql`substr(coalesce(${integrationTaskEvents.responseText}, '') || ${text}, -48000)` : '', updatedAt: new Date(),
  }).where(and(eq(integrationTaskEvents.integrationId, integrationId), eq(integrationTaskEvents.taskId, taskId),
    eq(integrationTaskEvents.sessionId, sessionId), eventId ? eq(integrationTaskEvents.id, eventId) : undefined,
    inArray(integrationTaskEvents.status, ['running', 'awaiting_input']),
  )).run()
}

export function preparePublication(row: StoredTaskEvent, kind: TaskPublication['kind'], body: string): void {
  const publication = JSON.stringify(taskPublicationSchema.parse({ id: crypto.randomUUID(), kind, body }))
  db.update(integrationTaskEvents).set({ status: 'responding', updatedAt: new Date(),
    publicationJson: kind === 'error' ? publication : sql`coalesce(${integrationTaskEvents.publicationJson}, ${publication})`,
  }).where(and(eq(integrationTaskEvents.id, row.id), inArray(integrationTaskEvents.status, ['running', 'awaiting_input']))).run()
}
export function taskContextUpdates(integrationId: string, taskId: string): TaskEvent[] {
  return db.select().from(integrationTaskEvents).where(and(
    eq(integrationTaskEvents.integrationId, integrationId), eq(integrationTaskEvents.taskId, taskId),
    eq(integrationTaskEvents.status, 'context'),
  )).orderBy(desc(integrationTaskEvents.createdAt)).limit(20).all().reverse().map(readTaskEvent)
}

export function wasStopped(integrationId: string, event: TaskEvent): boolean {
  const stops = db.select().from(integrationTaskEvents).where(and(
    eq(integrationTaskEvents.integrationId, integrationId), eq(integrationTaskEvents.taskId, event.taskId),
    like(integrationTaskEvents.externalEventId, 'stop:%'),
  )).orderBy(desc(integrationTaskEvents.createdAt)).limit(50).all()
  return stops.some(row => {
    const stop = readTaskEvent(row)
    return (!stop.interactionId || stop.interactionId === event.interactionId) && Date.parse(stop.timestamp) >= Date.parse(event.timestamp)
  })
}

export function findTaskEvent(integrationId: string, externalEventId: string): StoredTaskEvent | undefined {
  return db.select().from(integrationTaskEvents).where(and(
    eq(integrationTaskEvents.integrationId, integrationId), eq(integrationTaskEvents.externalEventId, externalEventId),
  )).get()
}

/** Include accepted work that has not created its runtime session yet. */
export function taskEventHistory(integrationId: string): StoredTaskEvent[] {
  return db.select().from(integrationTaskEvents).where(eq(integrationTaskEvents.integrationId, integrationId)).orderBy(asc(integrationTaskEvents.createdAt)).all()
}
