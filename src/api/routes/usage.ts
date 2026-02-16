import { Hono } from 'hono'
import { listAgents } from '@shared/lib/services/agent-service'
import { getAgentClaudeConfigDir } from '@shared/lib/utils/file-storage'
import { subDays, format, addDays } from 'date-fns'
import type { DailyUsageEntry, UsageResponse } from '@shared/lib/types/usage'

const usage = new Hono()

usage.get('/', async (c) => {
  const daysParam = c.req.query('days')
  const days = Math.min(Math.max(parseInt(daysParam || '7', 10) || 7, 1), 90)

  const now = new Date()
  const sinceDate = subDays(now, days)
  const since = format(sinceDate, 'yyyyMMdd')

  const agents = await listAgents()

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
