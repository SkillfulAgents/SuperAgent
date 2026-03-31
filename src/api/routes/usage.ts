import { Hono } from 'hono'
import { listAgents, getAgent } from '@shared/lib/services/agent-service'
import { getAgentClaudeConfigDir } from '@shared/lib/utils/file-storage'
import { loadDailyUsageData } from '@shared/lib/services/usage-service'
import { subDays, format, addDays } from 'date-fns'
import type { DailyUsageEntry, UsageResponse } from '@shared/lib/types/usage'
import { Authenticated } from '../middleware/auth'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import pLimit from 'p-limit'

/**
 * Normalize non-standard model names to canonical Anthropic names so that
 * pricing can be looked up and the chart consolidates equivalent models.
 *
 * Handles:
 * - OpenRouter: "anthropic/claude-4.6-opus-20260205" → "claude-opus-4-6"
 * - Bedrock:    "us.anthropic.claude-opus-4-6-v1"    → "claude-opus-4-6"
 *               "global.anthropic.claude-sonnet-4-6"  → "claude-sonnet-4-6"
 */
function normalizeModelName(model: string): string {
  // Bedrock format: "{region}.anthropic.{model-id}" or "anthropic.{model-id}"
  // Strip region prefix and "anthropic." prefix, then strip trailing "-v1:0" / "-v1" suffixes
  const bedrockMatch = model.match(/^(?:[\w-]+\.)?anthropic\.(.+)$/)
  if (bedrockMatch) {
    return bedrockMatch[1].replace(/-v\d+(?::\d+)?$/, '')
  }

  // OpenRouter format: "anthropic/claude-{version}-{family}-{date}"
  const stripped = model.includes('/') ? model.split('/').pop()! : model
  const openRouterMatch = stripped.match(/^claude-(\d+(?:\.\d+)?)-(\w+)(?:-\d+)?$/)
  if (openRouterMatch) {
    const [, version, family] = openRouterMatch
    const normalizedVersion = version.replace('.', '-')
    return `claude-${family}-${normalizedVersion}`
  }

  return model
}

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
    const agentLimit = pLimit(10)
    const results = await Promise.all(rows.map((r) => agentLimit(() => getAgent(r.agentSlug))))
    agents = results.filter(Boolean) as Awaited<ReturnType<typeof listAgents>>
  } else {
    agents = await listAgents()
  }

  // Aggregate: date -> { totalCost, totalTokens, byAgent, byModel }
  const dateMap = new Map<string, {
    totalCost: number
    totalTokens: number
    byAgent: Map<string, { agentSlug: string; agentName: string; cost: number; totalTokens: number }>
    byModel: Map<string, number>
  }>()

  // Process agents in batches to balance throughput and memory usage.
  // Each agent's JSONL files are read with pLimit concurrency internally.
  const BATCH_SIZE = 3
  for (let i = 0; i < agents.length; i += BATCH_SIZE) {
    const batch = agents.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(
      batch.map(async (agent) => {
        try {
          const claudePath = getAgentClaudeConfigDir(agent.slug)
          const dailyData = await loadDailyUsageData({ claudePath, since })
          return { agent, dailyData }
        } catch {
          return null
        }
      })
    )

    for (const result of results) {
      if (!result) continue
      const { agent, dailyData } = result

      for (const day of dailyData) {
        let entry = dateMap.get(day.date)
        if (!entry) {
          entry = { totalCost: 0, totalTokens: 0, byAgent: new Map(), byModel: new Map() }
          dateMap.set(day.date, entry)
        }

        const dayTokens = day.inputTokens + day.outputTokens + day.cacheCreationTokens + day.cacheReadTokens
        entry.totalCost += day.totalCost
        entry.totalTokens += dayTokens

        const existing = entry.byAgent.get(agent.slug)
        if (existing) {
          existing.cost += day.totalCost
          existing.totalTokens += dayTokens
        } else {
          entry.byAgent.set(agent.slug, {
            agentSlug: agent.slug,
            agentName: agent.frontmatter.name,
            cost: day.totalCost,
            totalTokens: dayTokens,
          })
        }

        for (const mb of day.modelBreakdowns) {
          const normalizedName = normalizeModelName(mb.modelName)
          const prev = entry.byModel.get(normalizedName) || 0
          entry.byModel.set(normalizedName, prev + mb.cost)
        }
      }
    }
  }

  // Fill in missing dates with zero-cost entries
  for (let d = sinceDate; d <= now; d = addDays(d, 1)) {
    const dateStr = format(d, 'yyyy-MM-dd')
    if (!dateMap.has(dateStr)) {
      dateMap.set(dateStr, { totalCost: 0, totalTokens: 0, byAgent: new Map(), byModel: new Map() })
    }
  }

  const daily: DailyUsageEntry[] = Array.from(dateMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => ({
      date,
      totalCost: data.totalCost,
      totalTokens: data.totalTokens,
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
