import { Hono } from 'hono'
import { listAgents, getAgent } from '@shared/lib/services/agent-service'
import { getAgentClaudeConfigDir } from '@shared/lib/utils/file-storage'
import { subDays, format, addDays } from 'date-fns'
import type { DailyUsageEntry, UsageResponse } from '@shared/lib/types/usage'
import { Authenticated } from '../middleware/auth'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'

/**
 * Normalize non-standard model names to canonical Anthropic names so that
 * ccusage can look up pricing and the chart consolidates equivalent models.
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
  const { PricingFetcher } = await import('ccusage/pricing-fetcher')
  process.env.LOG_LEVEL = prevLogLevel

  // Create a pricing fetcher for recalculating costs of models ccusage couldn't price
  const pricingFetcher = new PricingFetcher(false)

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
        const normalizedName = normalizeModelName(mb.modelName)
        let cost = mb.cost

        // If ccusage couldn't price this model (cost=0 but tokens exist),
        // retry pricing with the normalized name
        if (cost === 0 && normalizedName !== mb.modelName) {
          const totalTokens = mb.inputTokens + mb.outputTokens + mb.cacheCreationTokens + mb.cacheReadTokens
          if (totalTokens > 0) {
            try {
              cost = await pricingFetcher.calculateCostFromTokens({
                input_tokens: mb.inputTokens,
                output_tokens: mb.outputTokens,
                cache_creation_input_tokens: mb.cacheCreationTokens,
                cache_read_input_tokens: mb.cacheReadTokens,
              }, normalizedName)
              // Also add the recalculated cost to totals
              entry.totalCost += cost
              const agentEntry = entry.byAgent.get(agent.slug)
              if (agentEntry) agentEntry.cost += cost
            } catch {
              // Pricing lookup failed, keep cost as 0
            }
          }
        }

        const prev = entry.byModel.get(normalizedName) || 0
        entry.byModel.set(normalizedName, prev + cost)
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
