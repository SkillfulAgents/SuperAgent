import { and, eq, gte, inArray, sql, type SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { db } from '@shared/lib/db'
import {
  agentConnectedAccounts,
  agentRemoteMcps,
  connectedAccounts,
  mcpAuditLog,
  proxyAuditLog,
  remoteMcpServers,
  scheduledTasks,
  webhookTriggers,
} from '@shared/lib/db/schema'
import type { SessionMetadataMap } from '@shared/lib/types/agent'
import type {
  AgentActivityStats,
  ConnectionActivityStats,
  DailyActivityPoint,
} from '@shared/lib/types/activity'
import { DEFAULT_CRON_ACTIVITY_SLOTS } from '@shared/lib/types/activity'
import {
  activityDayKey,
  buildCronActivitySeries,
  buildDailyActivitySeries,
  FAILURE_POLICY_DECISIONS,
  getActivityWindowStart,
  normalizeAutomationStatus,
  type DailyActivityEvent,
} from './activity-aggregation'
import { readSessionMetadata } from './session-service'

export interface ActivityStatsOptions {
  days: number
  /** Viewer's `Date.prototype.getTimezoneOffset()`; buckets days locally. */
  tzOffsetMinutes?: number
  now?: Date
  cronSlots?: number
  /**
   * Whether a session's container subscription is currently live (the message
   * persister's view). A persisted 'running' automationStatus with no live
   * session is a run that died without a terminal result (container killed,
   * app quit mid-run) — it is reported as failed instead of pulsing forever.
   * Defaults to trusting the persisted status when no probe is supplied.
   */
  isSessionLive?: (sessionId: string) => boolean
}

export interface ConnectionStatsOptions extends ActivityStatsOptions {
  /** Undefined in local/single-user mode; set to the acting user in auth mode. */
  ownerId?: string
}

function dailyEventsById(
  ids: string[],
  eventsById: Map<string, DailyActivityEvent[]>,
  options: ActivityStatsOptions,
): Record<string, DailyActivityPoint[]> {
  return Object.fromEntries(ids.map((id) => [
    id,
    buildDailyActivitySeries(eventsById.get(id) ?? [], options),
  ]))
}

function pushEvent(
  eventsById: Map<string, DailyActivityEvent[]>,
  id: string,
  event: DailyActivityEvent,
): void {
  const events = eventsById.get(id)
  if (events) events.push(event)
  else eventsById.set(id, [event])
}

function webhookEvents(
  metadata: SessionMetadataMap,
  options: ActivityStatsOptions,
): Map<string, DailyActivityEvent[]> {
  const events = new Map<string, DailyActivityEvent[]>()

  for (const [sessionId, meta] of Object.entries(metadata)) {
    if (!meta.isWebhookExecution || !meta.webhookTriggerId || !meta.createdAt) continue
    // In-flight runs are neither a success nor a failure yet — leave them out
    // of the daily bars until the terminal result finalizes automationStatus.
    // A 'running' session with no live subscription died without a result and
    // counts as failed. Legacy sessions without a status predate outcome
    // tracking and count as succeeded.
    let status = normalizeAutomationStatus(meta.automationStatus)
    if (status === 'running') {
      if (!options.isSessionLive || options.isSessionLive(sessionId)) continue
      status = 'failed'
    }
    const createdAt = new Date(meta.createdAt)
    if (!Number.isFinite(createdAt.getTime())) continue
    pushEvent(events, meta.webhookTriggerId, {
      day: activityDayKey(createdAt, options.tzOffsetMinutes ?? 0),
      outcome: status === 'failed' ? 'failed' : 'succeeded',
      count: Number.isInteger(meta.webhookInvocationCount) && meta.webhookInvocationCount! > 0
        ? meta.webhookInvocationCount
        : 1,
    })
  }

  return events
}

// Audit tables grow with every proxied call and have no time-based retention,
// so the per-day/outcome rollup happens in SQL — the app only ever
// materializes at most (connections × days × 2) aggregate rows, never the raw
// request log.
function auditDayExpr(createdAt: SQLiteColumn, tzOffsetMinutes: number): SQL<string> {
  return sql<string>`date((${createdAt} / 1000) - ${tzOffsetMinutes * 60}, 'unixepoch')`
}

// SQL twin of the outcome rules (failure policy decisions, non-2xx/3xx or
// missing status, explicit error message). FAILURE_POLICY_DECISIONS is shared
// with activity-aggregation so the lists cannot drift.
function auditOutcomeExpr(table: typeof proxyAuditLog | typeof mcpAuditLog): SQL<string> {
  return sql<string>`case
    when ${table.errorMessage} is not null and ${table.errorMessage} <> '' then 'failed'
    when ${inArray(table.policyDecision, [...FAILURE_POLICY_DECISIONS])} then 'failed'
    when ${table.statusCode} is null then 'failed'
    when ${table.statusCode} >= 200 and ${table.statusCode} < 400 then 'succeeded'
    else 'failed'
  end`
}

interface AuditRollupRow {
  id: string
  day: string
  outcome: string
  count: number
}

function auditRollupQuery(
  table: typeof proxyAuditLog | typeof mcpAuditLog,
  idColumn: SQLiteColumn,
  where: SQL | undefined,
  tzOffsetMinutes: number,
): Promise<AuditRollupRow[]> {
  const day = auditDayExpr(table.createdAt, tzOffsetMinutes)
  const outcome = auditOutcomeExpr(table)
  return db
    .select({
      id: idColumn,
      day,
      outcome,
      count: sql<number>`count(*)`,
    })
    .from(table)
    .where(where)
    .groupBy(idColumn, day, outcome) as Promise<AuditRollupRow[]>
}

function requestEventsByConnection(
  proxyRows: AuditRollupRow[],
  mcpRows: AuditRollupRow[],
): Map<string, DailyActivityEvent[]> {
  const events = new Map<string, DailyActivityEvent[]>()
  for (const { rows, prefix } of [
    { rows: proxyRows, prefix: 'account' },
    { rows: mcpRows, prefix: 'mcp' },
  ]) {
    for (const row of rows) {
      pushEvent(events, `${prefix}-${row.id}`, {
        day: row.day,
        outcome: row.outcome === 'succeeded' ? 'succeeded' : 'failed',
        count: row.count,
      })
    }
  }
  return events
}

export async function getAgentActivityStats(
  agentSlug: string,
  options: ActivityStatsOptions,
): Promise<AgentActivityStats> {
  const now = options.now ?? new Date()
  const tzOffsetMinutes = options.tzOffsetMinutes ?? 0
  const from = getActivityWindowStart(options.days, now, tzOffsetMinutes)

  const [
    tasks,
    triggers,
    metadata,
    accountMappings,
    mcpMappings,
    proxyRows,
    mcpRows,
  ] = await Promise.all([
    db.select().from(scheduledTasks).where(eq(scheduledTasks.agentSlug, agentSlug)),
    db.select().from(webhookTriggers).where(eq(webhookTriggers.agentSlug, agentSlug)),
    readSessionMetadata(agentSlug),
    db.select({ id: agentConnectedAccounts.connectedAccountId })
      .from(agentConnectedAccounts)
      .where(eq(agentConnectedAccounts.agentSlug, agentSlug)),
    db.select({ id: agentRemoteMcps.remoteMcpId })
      .from(agentRemoteMcps)
      .where(eq(agentRemoteMcps.agentSlug, agentSlug)),
    auditRollupQuery(proxyAuditLog, proxyAuditLog.accountId, and(
      eq(proxyAuditLog.agentSlug, agentSlug),
      gte(proxyAuditLog.createdAt, from),
    ), tzOffsetMinutes),
    auditRollupQuery(mcpAuditLog, mcpAuditLog.remoteMcpId, and(
      eq(mcpAuditLog.agentSlug, agentSlug),
      gte(mcpAuditLog.createdAt, from),
    ), tzOffsetMinutes),
  ])

  // One pass over the metadata map, grouped by task; a persisted 'running'
  // with no live session is downgraded to failed (see isSessionLive).
  const sessionsByTaskId = new Map<string, Array<{
    scheduledExecutionAt?: string
    automationStatus?: 'running' | 'succeeded' | 'failed'
  }>>()
  for (const [sessionId, meta] of Object.entries(metadata)) {
    if (!meta.scheduledTaskId) continue
    let status = normalizeAutomationStatus(meta.automationStatus)
    if (status === 'running' && options.isSessionLive && !options.isSessionLive(sessionId)) {
      status = 'failed'
    }
    const sessions = sessionsByTaskId.get(meta.scheduledTaskId) ?? []
    sessions.push({ scheduledExecutionAt: meta.scheduledExecutionAt, automationStatus: status })
    sessionsByTaskId.set(meta.scheduledTaskId, sessions)
  }

  const cronByTaskId = Object.fromEntries(
    tasks
      .filter((task) => task.scheduleType === 'cron')
      .map((task) => [task.id, buildCronActivitySeries({
        task,
        sessions: sessionsByTaskId.get(task.id) ?? [],
        now,
        slots: options.cronSlots ?? DEFAULT_CRON_ACTIVITY_SLOTS,
      })]),
  )

  const webhookIds = triggers.map((trigger) => trigger.id)
  const webhookByTriggerId = dailyEventsById(
    webhookIds,
    webhookEvents(metadata, { ...options, tzOffsetMinutes }),
    { ...options, now, tzOffsetMinutes },
  )

  const accountIds = new Set(accountMappings.map((mapping) => mapping.id))
  const mcpIds = new Set(mcpMappings.map((mapping) => mapping.id))
  const connectionIds = [
    ...[...accountIds].map((id) => `account-${id}`),
    ...[...mcpIds].map((id) => `mcp-${id}`),
  ]
  const requestEvents = requestEventsByConnection(
    proxyRows.filter((row) => accountIds.has(row.id)),
    mcpRows.filter((row) => mcpIds.has(row.id)),
  )
  const connectionById = dailyEventsById(connectionIds, requestEvents, { ...options, now, tzOffsetMinutes })

  return {
    days: options.days,
    generatedAt: now.toISOString(),
    cronByTaskId,
    webhookByTriggerId,
    connectionById,
  }
}

export async function getConnectionActivityStats(
  options: ConnectionStatsOptions,
): Promise<ConnectionActivityStats> {
  const now = options.now ?? new Date()
  const tzOffsetMinutes = options.tzOffsetMinutes ?? 0
  const from = getActivityWindowStart(options.days, now, tzOffsetMinutes)
  const accountCondition = options.ownerId
    ? eq(connectedAccounts.userId, options.ownerId)
    : undefined
  const mcpCondition = options.ownerId
    ? eq(remoteMcpServers.userId, options.ownerId)
    : undefined

  const [accounts, mcps] = await Promise.all([
    accountCondition
      ? db.select({ id: connectedAccounts.id }).from(connectedAccounts).where(accountCondition)
      : db.select({ id: connectedAccounts.id }).from(connectedAccounts),
    mcpCondition
      ? db.select({ id: remoteMcpServers.id }).from(remoteMcpServers).where(mcpCondition)
      : db.select({ id: remoteMcpServers.id }).from(remoteMcpServers),
  ])
  const accountIds = accounts.map((account) => account.id)
  const mcpIds = mcps.map((mcp) => mcp.id)

  const [proxyRows, mcpRows] = await Promise.all([
    accountIds.length > 0
      ? auditRollupQuery(proxyAuditLog, proxyAuditLog.accountId, and(
          inArray(proxyAuditLog.accountId, accountIds),
          gte(proxyAuditLog.createdAt, from),
        ), tzOffsetMinutes)
      : Promise.resolve([]),
    mcpIds.length > 0
      ? auditRollupQuery(mcpAuditLog, mcpAuditLog.remoteMcpId, and(
          inArray(mcpAuditLog.remoteMcpId, mcpIds),
          gte(mcpAuditLog.createdAt, from),
        ), tzOffsetMinutes)
      : Promise.resolve([]),
  ])

  const connectionIds = [
    ...accountIds.map((id) => `account-${id}`),
    ...mcpIds.map((id) => `mcp-${id}`),
  ]
  const connectionById = dailyEventsById(
    connectionIds,
    requestEventsByConnection(proxyRows, mcpRows),
    { ...options, now, tzOffsetMinutes },
  )

  return {
    days: options.days,
    generatedAt: now.toISOString(),
    connectionById,
  }
}
