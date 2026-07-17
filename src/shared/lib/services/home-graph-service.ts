/**
 * Home Graph Service — assembles the topology snapshot behind
 * GET /api/home-graph: every edge fact of the home connections graph in a
 * handful of whole-table queries instead of a per-agent client fan-out.
 *
 * Node identity (agents, accounts, MCPs) is deliberately NOT assembled here —
 * the renderer keeps using the existing global endpoints for those, which is
 * what keeps agent status live via SSE.
 *
 * The route owns request concerns (auth extraction, error mapping); this
 * service takes the already-resolved scope so it can be tested against an
 * in-memory database.
 */

import fs from 'node:fs'
import pLimit from 'p-limit'
import { count, eq, inArray, isNotNull, ne, and } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import {
  agentConnectedAccounts,
  agentRemoteMcps,
  connectedAccounts,
  mcpAuditLog,
  proxyAuditLog,
  remoteMcpServers,
  xAgentPolicies,
} from '@shared/lib/db/schema'
import type { HomeGraphData } from '@shared/lib/types/home-graph-schema'
import {
  listChatIntegrationsByAgents,
  countSessionsPerIntegration,
} from './chat-integration-service'
import { listActiveWebhookTriggersByAgents } from './webhook-trigger-service'
import { listPendingScheduledTasksByAgents } from './scheduled-task-service'
import { readSessionMetadata } from './session-service'
import { getAgentSessionMetadataPath } from '@shared/lib/utils/file-storage'

export interface HomeGraphScope {
  /** Agents the caller may see (ACL-resolved in auth mode, all otherwise) */
  agentSlugs: string[]
  /** Scopes usage counts to the caller's accounts/servers; null outside auth mode */
  userId: string | null
  /** Live chat transport state (injected — the manager imports this service's siblings) */
  isIntegrationConnected: (integrationId: string) => boolean
}

/**
 * Per-agent cache of "who invoked this agent, how many times", keyed on the
 * metadata file's stat identity. Lifetime invocation counts require walking
 * the agent's ENTIRE session metadata map — hundreds of thousands of
 * Zod-validated entries for a heavy user — so re-deriving them on every
 * /api/home-graph request doesn't scale. Metadata writes are atomic
 * temp-file+rename (see session-service), so any change moves mtime; a
 * matching (mtimeMs, size) pair means the counts are still valid and the
 * request pays one stat() instead of a parse. Counts are cached UNFILTERED
 * (all callers) so a change in the caller's visible-agent set never
 * invalidates them — visibility is applied per request in countInvocations.
 */
const invocationCache = new Map<string, { mtimeMs: number; size: number; callerCounts: Map<string, number> }>()

/** Test seam: metadata rewrites within one mtime granule are indistinguishable to stat. */
export function clearInvocationCache(): void {
  invocationCache.clear()
}

async function countCallersForAgent(slug: string): Promise<Map<string, number>> {
  const metadataPath = getAgentSessionMetadataPath(slug)
  let stat: fs.Stats | null = null
  try {
    stat = await fs.promises.stat(metadataPath)
  } catch {
    // No statable file: drop any stale entry and fall through to the
    // graceful reader (it degrades to {} on ENOENT; tests stub it without
    // backing files). Nothing gets cached on this path.
    invocationCache.delete(slug)
  }
  if (stat) {
    const cached = invocationCache.get(slug)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.callerCounts
    }
  }
  // readSessionMetadata degrades to {} on a missing/corrupt file.
  const metadata = await readSessionMetadata(slug)
  const callerCounts = new Map<string, number>()
  for (const meta of Object.values(metadata)) {
    const caller = meta.invokedByAgentSlug
    if (!caller || caller === slug) continue
    callerCounts.set(caller, (callerCounts.get(caller) ?? 0) + 1)
  }
  if (stat) {
    invocationCache.set(slug, { mtimeMs: stat.mtimeMs, size: stat.size, callerCounts })
  }
  return callerCounts
}

/**
 * Actual agent→agent communication, counted from each visible agent's session
 * metadata: sessions record which agent invoked them (`invokedByAgentSlug`).
 */
async function countInvocations(
  agentSlugs: string[],
  visible: Set<string>,
): Promise<HomeGraphData['invocations']> {
  const counts = new Map<string, number>()
  const limit = pLimit(10)
  await Promise.all(
    agentSlugs.map((slug) =>
      limit(async () => {
        const callerCounts = await countCallersForAgent(slug)
        for (const [caller, n] of callerCounts) {
          if (!visible.has(caller)) continue
          const key = `${caller}\u0000${slug}`
          counts.set(key, n)
        }
      }),
    ),
  )
  return [...counts]
    .map(([key, n]) => {
      const [caller, target] = key.split('\u0000')
      return { caller, target, count: n }
    })
    .sort((a, b) => a.caller.localeCompare(b.caller) || a.target.localeCompare(b.target))
}

/**
 * Proxied-call counts per "agentSlug:accountId". Scoped three ways: to the
 * visible agents (in auth mode a usage key would otherwise leak a slug the
 * viewer has no ACL on — same anti-topology-leak rule as the permission
 * edges), to CURRENT agent↔account links (the graph only draws edges for
 * live links, so counts for since-unlinked pairs are dead payload), and via
 * the accounts join so auth mode sees only the caller's own accounts.
 * Weights are decorative — failures degrade to {}.
 */
async function accountUsageCounts(agentSlugs: string[], userId: string | null): Promise<Record<string, number>> {
  try {
    const rows = await db
      .select({ agentSlug: proxyAuditLog.agentSlug, accountId: proxyAuditLog.accountId, calls: count() })
      .from(proxyAuditLog)
      .innerJoin(connectedAccounts, eq(proxyAuditLog.accountId, connectedAccounts.id))
      .innerJoin(
        agentConnectedAccounts,
        and(
          eq(agentConnectedAccounts.agentSlug, proxyAuditLog.agentSlug),
          eq(agentConnectedAccounts.connectedAccountId, proxyAuditLog.accountId),
        ),
      )
      .where(
        and(
          inArray(proxyAuditLog.agentSlug, agentSlugs),
          userId ? eq(connectedAccounts.userId, userId) : undefined,
        ),
      )
      .groupBy(proxyAuditLog.agentSlug, proxyAuditLog.accountId)

    const counts: Record<string, number> = {}
    for (const row of rows) counts[`${row.agentSlug}:${row.accountId}`] = row.calls
    return counts
  } catch (error) {
    console.error('Failed to aggregate account usage counts:', error)
    return {}
  }
}

async function mcpUsageCounts(agentSlugs: string[], userId: string | null): Promise<Record<string, number>> {
  try {
    const rows = await db
      .select({ agentSlug: mcpAuditLog.agentSlug, mcpId: mcpAuditLog.remoteMcpId, calls: count() })
      .from(mcpAuditLog)
      .innerJoin(remoteMcpServers, eq(mcpAuditLog.remoteMcpId, remoteMcpServers.id))
      .innerJoin(
        agentRemoteMcps,
        and(
          eq(agentRemoteMcps.agentSlug, mcpAuditLog.agentSlug),
          eq(agentRemoteMcps.remoteMcpId, mcpAuditLog.remoteMcpId),
        ),
      )
      .where(
        and(
          inArray(mcpAuditLog.agentSlug, agentSlugs),
          userId ? eq(remoteMcpServers.userId, userId) : undefined,
        ),
      )
      .groupBy(mcpAuditLog.agentSlug, mcpAuditLog.remoteMcpId)

    const counts: Record<string, number> = {}
    for (const row of rows) counts[`${row.agentSlug}:${row.mcpId}`] = row.calls
    return counts
  } catch (error) {
    console.error('Failed to aggregate MCP usage counts:', error)
    return {}
  }
}

export async function buildHomeGraph(scope: HomeGraphScope): Promise<HomeGraphData> {
  const { agentSlugs, userId } = scope
  if (agentSlugs.length === 0) {
    return {
      accountLinks: [],
      mcpLinks: [],
      chats: [],
      webhooks: [],
      crons: [],
      permissions: [],
      invocations: [],
      accountUsage: {},
      mcpUsage: {},
    }
  }
  const visible = new Set(agentSlugs)

  const [accountLinkRows, mcpLinkRows, permissionRows, webhooksByAgent, cronsByAgent, invocations, accountUsage, mcpUsage] =
    await Promise.all([
      db
        .select({ agentSlug: agentConnectedAccounts.agentSlug, accountId: agentConnectedAccounts.connectedAccountId })
        .from(agentConnectedAccounts)
        .where(inArray(agentConnectedAccounts.agentSlug, agentSlugs)),
      db
        .select({ agentSlug: agentRemoteMcps.agentSlug, mcpId: agentRemoteMcps.remoteMcpId })
        .from(agentRemoteMcps)
        .where(inArray(agentRemoteMcps.agentSlug, agentSlugs)),
      db
        .select({ caller: xAgentPolicies.callerAgentSlug, target: xAgentPolicies.targetAgentSlug })
        .from(xAgentPolicies)
        .where(
          and(
            inArray(xAgentPolicies.callerAgentSlug, agentSlugs),
            // Target must be visible too — same anti-topology-leak rule as the
            // per-agent policies route: never surface slugs the viewer has no
            // ACL on. (The graph couldn't draw those edges anyway.)
            inArray(xAgentPolicies.targetAgentSlug, agentSlugs),
            eq(xAgentPolicies.operation, 'invoke'),
            ne(xAgentPolicies.decision, 'block'),
            isNotNull(xAgentPolicies.targetAgentSlug),
          ),
        ),
      listActiveWebhookTriggersByAgents(agentSlugs),
      listPendingScheduledTasksByAgents(agentSlugs),
      countInvocations(agentSlugs, visible),
      accountUsageCounts(agentSlugs, userId),
      mcpUsageCounts(agentSlugs, userId),
    ])

  const chatsByAgent = listChatIntegrationsByAgents(agentSlugs, { allStatuses: true })
  const sessionCounts = countSessionsPerIntegration(agentSlugs)

  const chats: HomeGraphData['chats'] = [...chatsByAgent.values()].flat().map((chat) => ({
    id: chat.id,
    agentSlug: chat.agentSlug,
    provider: chat.provider,
    name: chat.name,
    status: chat.status,
    connected: scope.isIntegrationConnected(chat.id),
    sessionCount: sessionCounts[chat.id] ?? 0,
  }))

  const webhooks: HomeGraphData['webhooks'] = [...webhooksByAgent.values()].flat().map((row) => ({
    id: row.id,
    agentSlug: row.agentSlug,
    triggerType: row.triggerType,
    name: row.name,
    status: row.status,
    fireCount: row.fireCount,
  }))

  // Session wakes (resumeSessionId) are session-scoped sleep timers, not
  // agent-level automations — the scheduled-tasks route excludes them for
  // the same reason, and a heavy long-sleep user would otherwise grow one
  // bogus "one-time" cron node per sleeping session.
  const crons: HomeGraphData['crons'] = [...cronsByAgent.values()]
    .flat()
    .filter((row) => !row.resumeSessionId)
    .map((row) => ({
    id: row.id,
    agentSlug: row.agentSlug,
    name: row.name,
    scheduleExpression: row.scheduleExpression,
    isRecurring: row.isRecurring,
    status: row.status,
    executionCount: row.executionCount,
  }))

  return {
    accountLinks: accountLinkRows,
    mcpLinks: mcpLinkRows,
    chats,
    webhooks,
    crons,
    // isNotNull() above guarantees target; the filter narrows the type.
    permissions: permissionRows.filter((p): p is { caller: string; target: string } => p.target !== null),
    invocations,
    accountUsage,
    mcpUsage,
  }
}
