import { and, asc, eq, inArray, lte, notInArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import { integrationTaskEvents, linearIssueCursors } from '../../db/schema'
import type { DirectIssue } from './direct-schema'
import type { TrackedLinearIssue } from './direct-events'

export const ISSUE_POLL_BATCH_SIZE = 25
export const DORMANT_ISSUE_POLL_MS = 15 * 60 * 1000
const ACTIVE_ISSUE_POLL_MS = 30000

/** Upgrade existing installations once on connect, without decoding transcripts.
 * Old retirement markers retain the access-gap cursor so replies are recoverable. */
export async function initializeIssueCursors(integrationId: string, cursor: string): Promise<void> {
  await db.insert(linearIssueCursors).select(db.select({
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

export async function knownIssueIds(integrationId: string): Promise<Set<string>> {
  return new Set((await db.select({ taskId: linearIssueCursors.taskId }).from(linearIssueCursors)
    .where(eq(linearIssueCursors.integrationId, integrationId)).all()).map(row => row.taskId))
}

export async function rememberIssue(integrationId: string, taskId: string, since: string): Promise<void> {
  await db.insert(linearIssueCursors).values({ integrationId, taskId, firstSeenAt: since, syncedThrough: since, nextPollAt: new Date(0) })
    .onConflictDoUpdate({ target: [linearIssueCursors.integrationId, linearIssueCursors.taskId], set: {
      firstSeenAt: sql`min(${linearIssueCursors.firstSeenAt}, ${since})`,
    } }).run()
}

export async function wakeIssue(integrationId: string, taskId: string): Promise<void> {
  await db.update(linearIssueCursors).set({ nextPollAt: new Date(0) })
    .where(and(eq(linearIssueCursors.integrationId, integrationId), eq(linearIssueCursors.taskId, taskId))).run()
}

export async function hasDueIssues(integrationId: string): Promise<boolean> {
  return !!(await db.select({ taskId: linearIssueCursors.taskId }).from(linearIssueCursors).where(and(
    eq(linearIssueCursors.integrationId, integrationId), lte(linearIssueCursors.nextPollAt, new Date()),
  )).limit(1).get())
}

/** Bounded historical work per poll; subscription wakeups take priority. */
export async function dueIssues(integrationId: string, urgent: Set<string>): Promise<Map<string, TrackedLinearIssue>> {
  const priority = [...urgent].slice(0, ISSUE_POLL_BATCH_SIZE)
  const chosen = priority.length ? (await db.select().from(linearIssueCursors).where(and(
    eq(linearIssueCursors.integrationId, integrationId), inArray(linearIssueCursors.taskId, priority),
  )).all()) : []
  if (chosen.length < ISSUE_POLL_BATCH_SIZE) chosen.push(...(await db.select().from(linearIssueCursors).where(and(
    eq(linearIssueCursors.integrationId, integrationId), lte(linearIssueCursors.nextPollAt, new Date()),
    priority.length ? notInArray(linearIssueCursors.taskId, priority) : undefined,
  )).orderBy(asc(linearIssueCursors.nextPollAt), asc(linearIssueCursors.taskId)).limit(ISSUE_POLL_BATCH_SIZE - chosen.length).all()))
  return await issueTracking(integrationId, chosen)
}

export async function getIssueTracking(integrationId: string, taskId: string): Promise<TrackedLinearIssue> {
  const row = await db.select().from(linearIssueCursors).where(and(eq(linearIssueCursors.integrationId, integrationId), eq(linearIssueCursors.taskId, taskId))).get()
  if (!row) throw new Error('Linear issue sync record is missing')
  return (await issueTracking(integrationId, [row])).get(taskId)!
}

async function issueTracking(integrationId: string, rows: Array<typeof linearIssueCursors.$inferSelect>): Promise<Map<string, TrackedLinearIssue>> {
  const tracked = new Map(rows.map(row => [row.taskId, { since: row.firstSeenAt, syncedThrough: row.syncedThrough,
    inaccessibleSince: row.inaccessibleSince, threads: new Set<string>() }]))
  if (tracked.size) {
    // Only thread identifiers for this batch: never SELECT/parse event payloads.
    const roots = await db.select({ taskId: integrationTaskEvents.taskId,
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
export async function checkpointIssue(integrationId: string, taskId: string, issue: DirectIssue | null, started: number): Promise<void> {
  const dormant = !issue || !!issue.archivedAt || ['completed', 'canceled'].includes(issue.state.type)
  await db.update(linearIssueCursors).set({
    // Inaccessibility is reversible. Do not advance past unseen comments/history.
    syncedThrough: issue ? sql`max(${linearIssueCursors.syncedThrough}, ${new Date(started - 60000).toISOString()})` : linearIssueCursors.syncedThrough,
    inaccessibleSince: issue ? null : sql`coalesce(${linearIssueCursors.inaccessibleSince}, ${new Date(started).toISOString()})`,
    nextPollAt: new Date(started + (dormant ? DORMANT_ISSUE_POLL_MS : ACTIVE_ISSUE_POLL_MS)),
  }).where(and(eq(linearIssueCursors.integrationId, integrationId), eq(linearIssueCursors.taskId, taskId))).run()
}
