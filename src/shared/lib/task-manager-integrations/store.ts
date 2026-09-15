import { and, asc, desc, eq, inArray, like } from 'drizzle-orm'
import { db } from '../db'
import { integrationTaskEvents } from '../db/schema'
import type { TaskEvent, TaskPublication } from './types'
import { parseTaskJson, taskEventSchema, taskPublicationSchema } from './schemas'

export type StoredTaskEvent = typeof integrationTaskEvents.$inferSelect
const activeStatuses = ['running', 'awaiting_input', 'responding'] as const

export function enqueueTaskEvent(integrationId: string, event: TaskEvent): boolean {
  const now = new Date()
  return db.insert(integrationTaskEvents).values({
    id: crypto.randomUUID(), integrationId, externalEventId: event.id,
    taskId: event.taskId, interactionId: event.interactionId, eventJson: JSON.stringify(taskEventSchema.parse(event)),
    status: event.kind === 'context' ? 'context' : 'queued', createdAt: now, updatedAt: now,
  }).onConflictDoNothing().run().changes > 0
}
export function readTaskEvent(row: StoredTaskEvent): TaskEvent { return parseTaskJson(taskEventSchema, row.eventJson) }
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
  return db.transaction(() => {
    const row = getTaskEvent(id)
    if (!row || row.status !== 'queued' || activeTaskEvent(row.integrationId, row.taskId)) return
    updateTaskEvent(id, { status: 'running' })
    return getTaskEvent(id)
  })
}
export function updateTaskEvent(id: string, patch: Partial<Pick<StoredTaskEvent,
  'status' | 'sessionId' | 'responseText' | 'publicationJson' | 'publishedId' | 'inputRequestJson'>>): void {
  db.update(integrationTaskEvents).set({ ...patch, updatedAt: new Date() }).where(eq(integrationTaskEvents.id, id)).run()
}
export function preparePublication(row: StoredTaskEvent, kind: TaskPublication['kind'], body: string): TaskPublication {
  const existing = getTaskEvent(row.id)
  if (existing?.publicationJson) {
    updateTaskEvent(row.id, { status: 'responding' })
    return parseTaskJson(taskPublicationSchema, existing.publicationJson)
  }
  const publication: TaskPublication = { id: crypto.randomUUID(), kind, body }
  updateTaskEvent(row.id, { status: 'responding', publicationJson: JSON.stringify(taskPublicationSchema.parse(publication)) })
  return publication
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
