import { and, eq, gte, inArray } from 'drizzle-orm'
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
  buildCronActivitySeries,
  buildDailyActivitySeries,
  classifyRequestOutcome,
  getActivityWindowStart,
  type DailyActivityEvent,
} from './activity-aggregation'
import { readSessionMetadata } from './session-service'

interface ActivityStatsOptions {
  days: number
  now?: Date
  cronSlots?: number
}

interface ConnectionStatsOptions extends ActivityStatsOptions {
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
): Map<string, DailyActivityEvent[]> {
  const events = new Map<string, DailyActivityEvent[]>()

  for (const meta of Object.values(metadata)) {
    if (!meta.isWebhookExecution || !meta.webhookTriggerId || !meta.createdAt) continue
    // In-flight runs are neither a success nor a failure yet — leave them out
    // of the daily bars until the terminal result finalizes automationStatus.
    // Legacy sessions without a status predate outcome tracking and count as
    // succeeded.
    if (meta.automationStatus === 'running') continue
    const createdAt = new Date(meta.createdAt)
    if (!Number.isFinite(createdAt.getTime())) continue
    pushEvent(events, meta.webhookTriggerId, {
      createdAt,
      outcome: meta.automationStatus === 'failed' ? 'failed' : 'succeeded',
      count: Number.isInteger(meta.webhookInvocationCount) && meta.webhookInvocationCount! > 0
        ? meta.webhookInvocationCount
        : 1,
    })
  }

  return events
}

// Only the columns the aggregation needs — audit rows carry more (paths,
// scopes) that would be wasted I/O at this volume.
const proxyAuditColumns = {
  accountId: proxyAuditLog.accountId,
  statusCode: proxyAuditLog.statusCode,
  errorMessage: proxyAuditLog.errorMessage,
  policyDecision: proxyAuditLog.policyDecision,
  createdAt: proxyAuditLog.createdAt,
}

const mcpAuditColumns = {
  remoteMcpId: mcpAuditLog.remoteMcpId,
  statusCode: mcpAuditLog.statusCode,
  errorMessage: mcpAuditLog.errorMessage,
  policyDecision: mcpAuditLog.policyDecision,
  createdAt: mcpAuditLog.createdAt,
}

type ProxyAuditRow = { [K in keyof typeof proxyAuditColumns]: (typeof proxyAuditLog.$inferSelect)[K] }
type McpAuditRow = { [K in keyof typeof mcpAuditColumns]: (typeof mcpAuditLog.$inferSelect)[K] }

function requestEventsByConnection(
  proxyRows: ProxyAuditRow[],
  mcpRows: McpAuditRow[],
  allowedAccountIds?: Set<string>,
  allowedMcpIds?: Set<string>,
): Map<string, DailyActivityEvent[]> {
  const events = new Map<string, DailyActivityEvent[]>()
  for (const row of proxyRows) {
    if (allowedAccountIds && !allowedAccountIds.has(row.accountId)) continue
    pushEvent(events, `account-${row.accountId}`, {
      createdAt: row.createdAt,
      outcome: classifyRequestOutcome(row),
    })
  }
  for (const row of mcpRows) {
    if (allowedMcpIds && !allowedMcpIds.has(row.remoteMcpId)) continue
    pushEvent(events, `mcp-${row.remoteMcpId}`, {
      createdAt: row.createdAt,
      outcome: classifyRequestOutcome(row),
    })
  }
  return events
}

export async function getAgentActivityStats(
  agentSlug: string,
  options: ActivityStatsOptions,
): Promise<AgentActivityStats> {
  const now = options.now ?? new Date()
  const from = getActivityWindowStart(options.days, now)

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
    db.select(proxyAuditColumns).from(proxyAuditLog).where(and(
      eq(proxyAuditLog.agentSlug, agentSlug),
      gte(proxyAuditLog.createdAt, from),
    )),
    db.select(mcpAuditColumns).from(mcpAuditLog).where(and(
      eq(mcpAuditLog.agentSlug, agentSlug),
      gte(mcpAuditLog.createdAt, from),
    )),
  ])

  const sessionMetadata = Object.values(metadata)
  const cronByTaskId = Object.fromEntries(
    tasks
      .filter((task) => task.scheduleType === 'cron')
      .map((task) => [task.id, buildCronActivitySeries({
        task,
        sessions: sessionMetadata.filter((meta) => meta.scheduledTaskId === task.id),
        now,
        slots: options.cronSlots ?? DEFAULT_CRON_ACTIVITY_SLOTS,
      })]),
  )

  const webhookIds = triggers.map((trigger) => trigger.id)
  const webhookByTriggerId = dailyEventsById(
    webhookIds,
    webhookEvents(metadata),
    { ...options, now },
  )

  const accountIds = new Set(accountMappings.map((mapping) => mapping.id))
  const mcpIds = new Set(mcpMappings.map((mapping) => mapping.id))
  const connectionIds = [
    ...[...accountIds].map((id) => `account-${id}`),
    ...[...mcpIds].map((id) => `mcp-${id}`),
  ]
  const connectionById = dailyEventsById(
    connectionIds,
    requestEventsByConnection(proxyRows, mcpRows, accountIds, mcpIds),
    { ...options, now },
  )

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
  const from = getActivityWindowStart(options.days, now)
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
      ? db.select(proxyAuditColumns).from(proxyAuditLog).where(and(
          inArray(proxyAuditLog.accountId, accountIds),
          gte(proxyAuditLog.createdAt, from),
        ))
      : Promise.resolve([]),
    mcpIds.length > 0
      ? db.select(mcpAuditColumns).from(mcpAuditLog).where(and(
          inArray(mcpAuditLog.remoteMcpId, mcpIds),
          gte(mcpAuditLog.createdAt, from),
        ))
      : Promise.resolve([]),
  ])

  const connectionIds = [
    ...accountIds.map((id) => `account-${id}`),
    ...mcpIds.map((id) => `mcp-${id}`),
  ]
  const connectionById = dailyEventsById(
    connectionIds,
    requestEventsByConnection(
      proxyRows,
      mcpRows,
      new Set(accountIds),
      new Set(mcpIds),
    ),
    { ...options, now },
  )

  return {
    days: options.days,
    generatedAt: now.toISOString(),
    connectionById,
  }
}
