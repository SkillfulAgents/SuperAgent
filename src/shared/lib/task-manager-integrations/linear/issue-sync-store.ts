import { and, asc, eq, inArray, lte, notInArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import { integrationTaskEvents, linearIssueSync } from '../../db/schema'
import type { DirectIssue } from './direct-schema'
import type { TrackedLinearIssue } from './direct-events'

export const ISSUE_POLL_BATCH_SIZE = 25
export const DORMANT_ISSUE_POLL_MS = 15 * 60 * 1000
const ACTIVE_ISSUE_POLL_MS = 30000

/** Upgrade existing installations once on connect, without decoding transcripts.
 * Old retirement markers retain the access-gap cursor so replies are recoverable. */
export function initializeIssueSync(integrationId: string, cursor: string): void {
  db.insert(linearIssueSync).select(db.select({
    integrationId: integrationTaskEvents.integrationId,
    taskId: integrationTaskEvents.taskId,
    firstSeenAt: sql<string>`min(json_extract(${integrationTaskEvents.eventJson}, '$.timestamp'))`.as('first_seen_at'),
    syncedThrough: sql<string>`min(${cursor}, coalesce((select min(json_extract(retired.event_json, '$.timestamp'))
      from integration_task_events retired where retired.integration_id = ${integrationTaskEvents.integrationId}
      and retired.task_id = ${integrationTaskEvents.taskId} and retired.external_event_id like 'retire:%'), ${cursor}))`.as('synced_through'),
    nextPollAt: sql<Date>`0`.as('next_poll_at'),
    inaccessibleSince: sql<string | null>`null`.as('inaccessible_since'),
  }).from(integrationTaskEvents).where(and(eq(integrationTaskEvents.integrationId, integrationId),
    sql`json_extract(${integrationTaskEvents.eventJson}, '$.kind') in ('invocation', 'status')`,
  )).groupBy(integrationTaskEvents.integrationId, integrationTaskEvents.taskId)).onConflictDoNothing().run()
}

export function knownIssueIds(integrationId: string): Set<string> {
  return new Set(db.select({ taskId: linearIssueSync.taskId }).from(linearIssueSync)
    .where(eq(linearIssueSync.integrationId, integrationId)).all().map(row => row.taskId))
}

export function rememberIssue(integrationId: string, taskId: string, since: string): void {
  db.insert(linearIssueSync).values({ integrationId, taskId, firstSeenAt: since, syncedThrough: since, nextPollAt: new Date(0) })
    .onConflictDoUpdate({ target: [linearIssueSync.integrationId, linearIssueSync.taskId], set: {
      firstSeenAt: sql`min(${linearIssueSync.firstSeenAt}, ${since})`,
    } }).run()
}

export function wakeIssue(integrationId: string, taskId: string): void {
  db.update(linearIssueSync).set({ nextPollAt: new Date(0) })
    .where(and(eq(linearIssueSync.integrationId, integrationId), eq(linearIssueSync.taskId, taskId))).run()
}

export function hasDueIssues(integrationId: string): boolean {
  return !!db.select({ taskId: linearIssueSync.taskId }).from(linearIssueSync).where(and(
    eq(linearIssueSync.integrationId, integrationId), lte(linearIssueSync.nextPollAt, new Date()),
  )).limit(1).get()
}

/** Bounded historical work per poll; subscription wakeups take priority. */
export function dueIssues(integrationId: string, urgent: Set<string>): Map<string, TrackedLinearIssue> {
  const priority = [...urgent].slice(0, ISSUE_POLL_BATCH_SIZE)
  const chosen = priority.length ? db.select().from(linearIssueSync).where(and(
    eq(linearIssueSync.integrationId, integrationId), inArray(linearIssueSync.taskId, priority),
  )).all() : []
  if (chosen.length < ISSUE_POLL_BATCH_SIZE) chosen.push(...db.select().from(linearIssueSync).where(and(
    eq(linearIssueSync.integrationId, integrationId), lte(linearIssueSync.nextPollAt, new Date()),
    priority.length ? notInArray(linearIssueSync.taskId, priority) : undefined,
  )).orderBy(asc(linearIssueSync.nextPollAt), asc(linearIssueSync.taskId)).limit(ISSUE_POLL_BATCH_SIZE - chosen.length).all())
  return issueTracking(integrationId, chosen)
}

export function getIssueTracking(integrationId: string, taskId: string): TrackedLinearIssue {
  const row = db.select().from(linearIssueSync).where(and(eq(linearIssueSync.integrationId, integrationId), eq(linearIssueSync.taskId, taskId))).get()
  if (!row) throw new Error('Linear issue sync record is missing')
  return issueTracking(integrationId, [row]).get(taskId)!
}

function issueTracking(integrationId: string, rows: Array<typeof linearIssueSync.$inferSelect>): Map<string, TrackedLinearIssue> {
  const tracked = new Map(rows.map(row => [row.taskId, { since: row.firstSeenAt, syncedThrough: row.syncedThrough,
    inaccessibleSince: row.inaccessibleSince, threads: new Set<string>() }]))
  if (tracked.size) {
    // Only thread identifiers for this batch: never SELECT/parse event payloads.
    const roots = db.select({ taskId: integrationTaskEvents.taskId,
      root: sql<string | null>`coalesce(json_extract(${integrationTaskEvents.eventJson}, '$.replyTarget.commentId'), ${integrationTaskEvents.publishedId})`,
    }).from(integrationTaskEvents).where(and(eq(integrationTaskEvents.integrationId, integrationId),
      inArray(integrationTaskEvents.taskId, [...tracked.keys()]),
      sql`json_extract(${integrationTaskEvents.eventJson}, '$.kind') in ('invocation', 'status')`,
    )).all()
    for (const row of roots) if (row.root) tracked.get(row.taskId)!.threads.add(row.root)
  }
  return tracked
}

/** Called only after the entire issue batch has been durably accepted. */
export function checkpointIssue(integrationId: string, taskId: string, issue: DirectIssue | null, started: number): void {
  const dormant = !issue || !!issue.archivedAt || ['completed', 'canceled'].includes(issue.state.type)
  db.update(linearIssueSync).set({
    // Inaccessibility is reversible. Do not advance past unseen comments/history.
    syncedThrough: issue ? sql`max(${linearIssueSync.syncedThrough}, ${new Date(started - 60000).toISOString()})` : linearIssueSync.syncedThrough,
    inaccessibleSince: issue ? null : sql`coalesce(${linearIssueSync.inaccessibleSince}, ${new Date(started).toISOString()})`,
    nextPollAt: new Date(started + (dormant ? DORMANT_ISSUE_POLL_MS : ACTIVE_ISSUE_POLL_MS)),
  }).where(and(eq(linearIssueSync.integrationId, integrationId), eq(linearIssueSync.taskId, taskId))).run()
}
