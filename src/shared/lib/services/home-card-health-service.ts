/**
 * Home Card Health Service — the compact, card-only projection behind
 * GET /api/home-card-health.
 *
 * Unlike the graph snapshot, this path performs no topology, permissions,
 * chat/session-count, connection-usage, or invocation aggregation. It uses
 * two batched SQL queries and reads session metadata only for agents that
 * actually have a cron or webhook chart to render.
 */

import pLimit from 'p-limit'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { scheduledTasks, webhookTriggers } from '@shared/lib/db/schema'
import type { HomeCardHealthData } from '@shared/lib/types/home-card-health-schema'
import type { ActivityStatsOptions } from './activity-stats-service'
import { buildAutomationActivityStats } from './activity-stats-service'
import { readSessionMetadata } from './session-service'

export interface HomeCardHealthScope extends ActivityStatsOptions {
  /** Agents the caller may see (ACL-resolved in auth mode, all otherwise). */
  agentSlugs: string[]
}

type CardCronRow = Awaited<ReturnType<typeof listCardCrons>>[number]
type CardWebhookRow = Awaited<ReturnType<typeof listCardWebhooks>>[number]

async function listCardCrons(agentSlugs: string[]) {
  return db
    .select({
      id: scheduledTasks.id,
      agentSlug: scheduledTasks.agentSlug,
      name: scheduledTasks.name,
      scheduleType: scheduledTasks.scheduleType,
      scheduleExpression: scheduledTasks.scheduleExpression,
      timezone: scheduledTasks.timezone,
      createdAt: scheduledTasks.createdAt,
      pausedAt: scheduledTasks.pausedAt,
      cancelledAt: scheduledTasks.cancelledAt,
    })
    .from(scheduledTasks)
    .where(and(
      inArray(scheduledTasks.agentSlug, agentSlugs),
      inArray(scheduledTasks.status, ['pending', 'paused']),
      eq(scheduledTasks.scheduleType, 'cron'),
      // Session wake timers are `at` tasks today, but keep the explicit guard
      // so they cannot accidentally become homepage charts if that changes.
      isNull(scheduledTasks.resumeSessionId),
    ))
}

async function listCardWebhooks(agentSlugs: string[]) {
  return db
    .select({
      id: webhookTriggers.id,
      agentSlug: webhookTriggers.agentSlug,
      triggerType: webhookTriggers.triggerType,
      name: webhookTriggers.name,
    })
    .from(webhookTriggers)
    .where(and(
      inArray(webhookTriggers.agentSlug, agentSlugs),
      inArray(webhookTriggers.status, ['active', 'paused']),
    ))
}

function groupByAgent<T extends { agentSlug: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const current = grouped.get(row.agentSlug)
    if (current) current.push(row)
    else grouped.set(row.agentSlug, [row])
  }
  return grouped
}

export async function buildHomeCardHealth(
  scope: HomeCardHealthScope,
): Promise<HomeCardHealthData> {
  const now = scope.now ?? new Date()
  if (scope.agentSlugs.length === 0) {
    return {
      days: scope.days,
      generatedAt: now.toISOString(),
      crons: [],
      webhooks: [],
      cronByTaskId: {},
      webhookByTriggerId: {},
    }
  }

  const [cronRows, webhookRows] = await Promise.all([
    listCardCrons(scope.agentSlugs),
    listCardWebhooks(scope.agentSlugs),
  ])
  const cronsByAgent = groupByAgent<CardCronRow>(cronRows)
  const webhooksByAgent = groupByAgent<CardWebhookRow>(webhookRows)
  const agentsWithCharts = new Set([
    ...cronsByAgent.keys(),
    ...webhooksByAgent.keys(),
  ])

  const cronByTaskId: HomeCardHealthData['cronByTaskId'] = {}
  const webhookByTriggerId: HomeCardHealthData['webhookByTriggerId'] = {}
  const limit = pLimit(10)
  await Promise.all(
    [...agentsWithCharts].map((agentSlug) =>
      limit(async () => {
        const activity = buildAutomationActivityStats(
          agentSlug,
          cronsByAgent.get(agentSlug) ?? [],
          webhooksByAgent.get(agentSlug) ?? [],
          await readSessionMetadata(agentSlug),
          { ...scope, now },
        )
        Object.assign(cronByTaskId, activity.cronByTaskId)
        Object.assign(webhookByTriggerId, activity.webhookByTriggerId)
      }),
    ),
  )

  return {
    days: scope.days,
    generatedAt: now.toISOString(),
    crons: cronRows
      .map((row) => ({
        id: row.id,
        agentSlug: row.agentSlug,
        name: row.name,
        scheduleExpression: row.scheduleExpression,
      }))
      .sort((a, b) => a.agentSlug.localeCompare(b.agentSlug) || a.id.localeCompare(b.id)),
    webhooks: webhookRows
      .map((row) => ({
        id: row.id,
        agentSlug: row.agentSlug,
        triggerType: row.triggerType,
        name: row.name,
      }))
      .sort((a, b) => a.agentSlug.localeCompare(b.agentSlug) || a.id.localeCompare(b.id)),
    cronByTaskId,
    webhookByTriggerId,
  }
}
