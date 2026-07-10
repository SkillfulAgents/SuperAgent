/**
 * Data layer for the home connections graph.
 *
 * Two sources:
 *  - Node identity + live status: the existing global queries (agents,
 *    connected accounts, remote MCPs). These reuse the exact keys the rest
 *    of the app observes, so the GlobalNotificationHandler's SSE-driven
 *    invalidations keep agent status colors live with no extra wiring.
 *  - Topology (links, triggers, permissions, usage weights): one batch
 *    request to /api/home-graph, snapshotted per graph open. Edges don't
 *    need to be realtime; agent state does.
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useAgents, type ApiAgent } from '@renderer/hooks/use-agents'
import { useConnectedAccounts, type ConnectedAccount } from '@renderer/hooks/use-connected-accounts'
import { useRemoteMcps, type RemoteMcpServer } from '@renderer/hooks/use-remote-mcps'
import { homeGraphSchema, type HomeGraphData } from '@shared/lib/types/home-graph-schema'

// ── Domain model ─────────────────────────────────────────────────────────

export type ResourceTone = 'ok' | 'muted' | 'attention' | 'error'

export type AgentNodeData = {
  kind: 'agent'
  agent: ApiAgent
}

export type ResourceKind = 'account' | 'mcp' | 'webhook' | 'cron' | 'chat'

export type ResourceNodeData = {
  kind: ResourceKind
  resourceId: string
  label: string
  sublabel?: string
  tone: ResourceTone
  statusLabel: string
  /** Service icon slug (account toolkit / chat provider), when one exists */
  iconSlug?: string
  /** Owning agent, for webhook/cron/chat navigation */
  agentSlug?: string
}

export type GraphNodeData = AgentNodeData | ResourceNodeData

export interface GraphNodeSpec {
  id: string
  data: GraphNodeData
}

export type GraphEdgeVariant = 'resource' | 'trigger' | 'permission' | 'activity'

export interface GraphEdgeSpec {
  id: string
  source: string
  target: string
  variant: GraphEdgeVariant
  /** Interaction count (API calls, session invocations, trigger fires) — scales stroke width */
  weight?: number
}

export interface GraphModel {
  nodes: GraphNodeSpec[]
  edges: GraphEdgeSpec[]
}

export const nodeId = {
  agent: (slug: string) => `agent:${slug}`,
  account: (id: string) => `account:${id}`,
  mcp: (id: string) => `mcp:${id}`,
  webhook: (id: string) => `webhook:${id}`,
  cron: (id: string) => `cron:${id}`,
  chat: (id: string) => `chat:${id}`,
}

// ── Tone mapping ─────────────────────────────────────────────────────────

const ACCOUNT_TONE: Record<ConnectedAccount['status'], ResourceTone> = {
  active: 'ok',
  expired: 'attention',
  revoked: 'error',
}

const MCP_TONE: Record<RemoteMcpServer['status'], ResourceTone> = {
  active: 'ok',
  auth_required: 'attention',
  error: 'error',
}

function chatTone(status: string, connected: boolean): ResourceTone {
  if (status === 'error') return 'error'
  if (status === 'paused') return 'muted'
  if (status === 'disconnected') return 'attention'
  return connected ? 'ok' : 'attention'
}

const AUTOMATION_TONE: Record<string, ResourceTone> = {
  active: 'ok',
  pending: 'ok',
  paused: 'muted',
  failed: 'error',
  executed: 'muted',
  cancelled: 'muted',
}

// ── Graph assembly ───────────────────────────────────────────────────────

/**
 * Agent↔agent edges render as unmarked straight lines, so direction is
 * invisible — everything about a pair (activity in either direction, and
 * whether a permission line would be hidden underneath) must be keyed on
 * the unordered pair.
 */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

export function buildGraph(input: {
  agents: ApiAgent[]
  accounts: ConnectedAccount[]
  mcps: RemoteMcpServer[]
  topology: HomeGraphData | undefined
}): GraphModel {
  const nodes: GraphNodeSpec[] = []
  const edges: GraphEdgeSpec[] = []
  const agents = [...input.agents].sort((a, b) => a.slug.localeCompare(b.slug))
  const agentSlugSet = new Set(agents.map((a) => a.slug))
  const topology = input.topology

  for (const agent of agents) {
    nodes.push({ id: nodeId.agent(agent.slug), data: { kind: 'agent', agent } })
  }

  const accountIds = new Set<string>()
  for (const account of input.accounts) {
    accountIds.add(account.id)
    nodes.push({
      id: nodeId.account(account.id),
      data: {
        kind: 'account',
        resourceId: account.id,
        label: account.displayName || account.provider?.displayName || account.toolkitSlug,
        sublabel: account.status !== 'active' ? account.status : undefined,
        tone: ACCOUNT_TONE[account.status] ?? 'muted',
        statusLabel: `${account.toolkitSlug} · ${account.status}`,
        iconSlug: account.toolkitSlug,
      },
    })
  }

  const mcpIds = new Set<string>()
  for (const mcp of input.mcps) {
    mcpIds.add(mcp.id)
    nodes.push({
      id: nodeId.mcp(mcp.id),
      data: {
        kind: 'mcp',
        resourceId: mcp.id,
        label: mcp.name,
        sublabel: mcp.status !== 'active' ? mcp.status.replace('_', ' ') : undefined,
        tone: MCP_TONE[mcp.status] ?? 'muted',
        statusLabel: mcp.errorMessage ? `${mcp.status}: ${mcp.errorMessage}` : `MCP · ${mcp.status}`,
      },
    })
  }

  if (!topology) return { nodes, edges }

  // Links reference nodes owned by the queries above; drop any edge whose
  // endpoint isn't (yet) known — e.g. another user's account on a shared
  // agent, or a topology snapshot that outlived an agent deletion.
  for (const link of topology.accountLinks) {
    if (!agentSlugSet.has(link.agentSlug) || !accountIds.has(link.accountId)) continue
    const source = nodeId.agent(link.agentSlug)
    const target = nodeId.account(link.accountId)
    edges.push({
      id: `${source}->${target}`,
      source,
      target,
      variant: 'resource',
      weight: topology.accountUsage[`${link.agentSlug}:${link.accountId}`],
    })
  }

  for (const link of topology.mcpLinks) {
    if (!agentSlugSet.has(link.agentSlug) || !mcpIds.has(link.mcpId)) continue
    const source = nodeId.agent(link.agentSlug)
    const target = nodeId.mcp(link.mcpId)
    edges.push({
      id: `${source}->${target}`,
      source,
      target,
      variant: 'resource',
      weight: topology.mcpUsage[`${link.agentSlug}:${link.mcpId}`],
    })
  }

  for (const chat of topology.chats) {
    if (!agentSlugSet.has(chat.agentSlug)) continue
    const id = nodeId.chat(chat.id)
    nodes.push({
      id,
      data: {
        kind: 'chat',
        resourceId: chat.id,
        label: chat.name || chat.provider,
        sublabel: chat.provider,
        tone: chatTone(chat.status, chat.connected),
        statusLabel: `${chat.provider} · ${chat.connected ? 'listening' : chat.status}`,
        iconSlug: chat.provider,
        agentSlug: chat.agentSlug,
      },
    })
    const source = nodeId.agent(chat.agentSlug)
    edges.push({ id: `${source}->${id}`, source, target: id, variant: 'trigger', weight: chat.sessionCount })
  }

  for (const webhook of topology.webhooks) {
    if (!agentSlugSet.has(webhook.agentSlug)) continue
    const id = nodeId.webhook(webhook.id)
    nodes.push({
      id,
      data: {
        kind: 'webhook',
        resourceId: webhook.id,
        label: webhook.name || webhook.triggerType,
        sublabel: webhook.fireCount ? `${webhook.fireCount} fire${webhook.fireCount === 1 ? '' : 's'}` : undefined,
        tone: AUTOMATION_TONE[webhook.status] ?? 'muted',
        statusLabel: `webhook · ${webhook.status}`,
        agentSlug: webhook.agentSlug,
      },
    })
    const source = nodeId.agent(webhook.agentSlug)
    edges.push({ id: `${source}->${id}`, source, target: id, variant: 'trigger', weight: webhook.fireCount })
  }

  for (const task of topology.crons) {
    if (!agentSlugSet.has(task.agentSlug)) continue
    const id = nodeId.cron(task.id)
    nodes.push({
      id,
      data: {
        kind: 'cron',
        resourceId: task.id,
        label: task.name || task.scheduleExpression,
        sublabel: task.isRecurring ? task.scheduleExpression : 'one-time',
        tone: AUTOMATION_TONE[task.status] ?? 'muted',
        statusLabel: `scheduled · ${task.status}`,
        agentSlug: task.agentSlug,
      },
    })
    const source = nodeId.agent(task.agentSlug)
    edges.push({ id: `${source}->${id}`, source, target: id, variant: 'trigger', weight: task.executionCount })
  }

  // Merge invocations onto unordered pairs (A→B and B→A are visually one
  // line), then draw one solid activity edge per communicating pair…
  const activityByPair = new Map<string, number>()
  for (const inv of topology.invocations) {
    if (inv.caller === inv.target) continue
    if (!agentSlugSet.has(inv.caller) || !agentSlugSet.has(inv.target)) continue
    const key = pairKey(inv.caller, inv.target)
    activityByPair.set(key, (activityByPair.get(key) ?? 0) + inv.count)
  }
  for (const [key, weight] of [...activityByPair].sort(([a], [b]) => a.localeCompare(b))) {
    const [a, b] = key.split('|')
    edges.push({
      id: `${nodeId.agent(a)}=${nodeId.agent(b)}`,
      source: nodeId.agent(a),
      target: nodeId.agent(b),
      variant: 'activity',
      weight,
    })
  }

  // …and one dashed permission edge per permitted-but-silent pair. Any
  // recorded activity supersedes the permission line: both would occupy the
  // same straight segment, and the solid stroke hides the dashes.
  const permissionPairs = new Set<string>()
  for (const perm of topology.permissions) {
    if (perm.caller === perm.target) continue
    if (!agentSlugSet.has(perm.caller) || !agentSlugSet.has(perm.target)) continue
    const key = pairKey(perm.caller, perm.target)
    if (activityByPair.has(key) || permissionPairs.has(key)) continue
    permissionPairs.add(key)
    const [a, b] = key.split('|')
    edges.push({
      id: `${nodeId.agent(a)}~${nodeId.agent(b)}`,
      source: nodeId.agent(a),
      target: nodeId.agent(b),
      variant: 'permission',
    })
  }

  return { nodes, edges }
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useGraphData(): GraphModel & { isLoading: boolean; topologyFailed: boolean } {
  const { data: agents, isLoading: agentsLoading } = useAgents()
  const { data: accountsData } = useConnectedAccounts()
  const { data: mcpsData } = useRemoteMcps()

  // One snapshot per graph open (staleTime covers quick cards⇄graph flips);
  // parsed at the boundary so a drifting server shape fails loudly here.
  const topologyQuery = useQuery<HomeGraphData>({
    queryKey: ['home-graph'],
    queryFn: async () => {
      const res = await apiFetch('/api/home-graph')
      if (!res.ok) throw new Error('Failed to fetch home graph')
      return homeGraphSchema.parse(await res.json())
    },
    staleTime: 60_000,
  })

  const graph = useMemo(
    () =>
      buildGraph({
        agents: agents ?? [],
        accounts: Array.isArray(accountsData?.accounts) ? accountsData.accounts : [],
        mcps: Array.isArray(mcpsData?.servers) ? mcpsData.servers : [],
        topology: topologyQuery.data,
      }),
    [agents, accountsData, mcpsData, topologyQuery.data],
  )

  return {
    ...graph,
    isLoading: agentsLoading || topologyQuery.isPending,
    // Edges are decorative-ish, agents aren't: render the graph anyway and
    // let the canvas surface that connections are unavailable.
    topologyFailed: topologyQuery.isError,
  }
}
