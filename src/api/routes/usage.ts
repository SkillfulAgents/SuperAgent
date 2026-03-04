import { Hono } from 'hono'
import { listAgents, getAgent } from '@shared/lib/services/agent-service'
import { getAgentClaudeConfigDir } from '@shared/lib/utils/file-storage'
import { subDays, format, addDays } from 'date-fns'
import type { DailyUsageEntry, UsageResponse } from '@shared/lib/types/usage'
import { Authenticated } from '../middleware/auth'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { db } from '@shared/lib/db'
import { agentAcl, sttUsage } from '@shared/lib/db/schema'
import { eq, gte, and, sql } from 'drizzle-orm'

const usage = new Hono()

usage.use('*', Authenticated())

usage.get('/', async (c) => {
  const daysParam = c.req.query('days')
  const days = Math.min(Math.max(parseInt(daysParam || '7', 10) || 7, 1), 90)
  const globalParam = c.req.query('global') === 'true'
  // Only admins can request global view
  const user = isAuthMode() ? c.get('user' as never) as { id: string; role?: string } | undefined : undefined
  const globalView = globalParam && (!isAuthMode() || user?.role === 'admin')

  const now = new Date()
  const sinceDate = subDays(now, days)
  const since = format(sinceDate, 'yyyyMMdd')

  // In auth mode, only load agents the user has access to (unless admin requests global view)
  let agents;
  if (isAuthMode() && !globalView) {
    const userId = getCurrentUserId(c)
    const rows = await db
      .select({ agentSlug: agentAcl.agentSlug })
      .from(agentAcl)
      .where(eq(agentAcl.userId, userId))
    const results = await Promise.all(rows.map((r) => getAgent(r.agentSlug)))
    agents = results.filter(Boolean) as Awaited<ReturnType<typeof listAgents>>
  } else {
    agents = await listAgents()
  }

  // Dynamic import — ccusage is ESM-only
  // Suppress ccusage's consola logging
  const prevLogLevel = process.env.LOG_LEVEL
  process.env.LOG_LEVEL = '0'
  const { loadDailyUsageData } = await import('ccusage/data-loader')
  process.env.LOG_LEVEL = prevLogLevel

  // Aggregate: date -> { totalCost, byAgent, byModel }
  const dateMap = new Map<string, {
    totalCost: number
    byAgent: Map<string, { agentSlug: string; agentName: string; cost: number }>
    byModel: Map<string, number>
  }>()

  const results = await Promise.allSettled(
    agents.map(async (agent) => {
      const claudePath = getAgentClaudeConfigDir(agent.slug)
      const dailyData = await loadDailyUsageData({
        claudePath,
        offline: false,
        since,
      })
      return { agent, dailyData }
    })
  )

  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    const { agent, dailyData } = result.value

    for (const day of dailyData) {
      let entry = dateMap.get(day.date)
      if (!entry) {
        entry = { totalCost: 0, byAgent: new Map(), byModel: new Map() }
        dateMap.set(day.date, entry)
      }

      entry.totalCost += day.totalCost

      const existing = entry.byAgent.get(agent.slug)
      if (existing) {
        existing.cost += day.totalCost
      } else {
        entry.byAgent.set(agent.slug, {
          agentSlug: agent.slug,
          agentName: agent.frontmatter.name,
          cost: day.totalCost,
        })
      }

      for (const mb of day.modelBreakdowns) {
        const prev = entry.byModel.get(mb.modelName) || 0
        entry.byModel.set(mb.modelName, prev + mb.cost)
      }
    }
  }

  // Merge STT usage from the database
  const sttConditions = [gte(sttUsage.createdAt, sinceDate)]
  if (isAuthMode() && !globalView) {
    const userId = getCurrentUserId(c)
    sttConditions.push(eq(sttUsage.userId, userId))
  }

  const sttRows = await db
    .select({
      date: sql<string>`date(${sttUsage.createdAt} / 1000, 'unixepoch')`.as('date'),
      model: sttUsage.model,
      agentSlug: sttUsage.agentSlug,
      totalCostMicro: sql<number>`sum(${sttUsage.cost})`.as('total_cost_micro'),
    })
    .from(sttUsage)
    .where(and(...sttConditions))
    .groupBy(sql`date(${sttUsage.createdAt} / 1000, 'unixepoch')`, sttUsage.model, sttUsage.agentSlug)

  // Build a name cache for agent slugs referenced by STT rows
  const sttAgentSlugs = new Set(sttRows.map(r => r.agentSlug).filter(Boolean) as string[])
  const agentNameMap = new Map<string, string>()
  await Promise.all(Array.from(sttAgentSlugs).map(async (slug) => {
    const a = await getAgent(slug)
    agentNameMap.set(slug, a ? a.frontmatter.name : slug)
  }))

  for (const row of sttRows) {
    const costUsd = row.totalCostMicro / 1_000_000
    let entry = dateMap.get(row.date)
    if (!entry) {
      entry = { totalCost: 0, byAgent: new Map(), byModel: new Map() }
      dateMap.set(row.date, entry)
    }
    entry.totalCost += costUsd

    const prev = entry.byModel.get(row.model) || 0
    entry.byModel.set(row.model, prev + costUsd)

    if (row.agentSlug) {
      const existing = entry.byAgent.get(row.agentSlug)
      if (existing) {
        existing.cost += costUsd
      } else {
        entry.byAgent.set(row.agentSlug, {
          agentSlug: row.agentSlug,
          agentName: agentNameMap.get(row.agentSlug) || row.agentSlug,
          cost: costUsd,
        })
      }
    }
  }

  // Fill in missing dates with zero-cost entries
  for (let d = sinceDate; d <= now; d = addDays(d, 1)) {
    const dateStr = format(d, 'yyyy-MM-dd')
    if (!dateMap.has(dateStr)) {
      dateMap.set(dateStr, { totalCost: 0, byAgent: new Map(), byModel: new Map() })
    }
  }

  const daily: DailyUsageEntry[] = Array.from(dateMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => ({
      date,
      totalCost: data.totalCost,
      byAgent: Array.from(data.byAgent.values()),
      byModel: Array.from(data.byModel.entries()).map(([model, cost]) => ({
        model,
        cost,
      })),
    }))

  const response: UsageResponse = { daily }
  return c.json(response)
})

export default usage
