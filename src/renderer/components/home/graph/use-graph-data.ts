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
import { humanizeCron } from '@renderer/hooks/use-humanized-cron'
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
  /** Second line under the label — only crons use it (their schedule) */
  sublabel?: string
  /** Short status word for the hover badge ("connected", "expired", "listening") */
  status: string
  /**
   * Usage across all this resource's edges ("23 API calls", "never fired"),
   * shown as the pill's fine print on hover. Absent while topology loads.
   */
  usage?: string
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
  /** Interaction count (API calls, session invocations, trigger fires) — drives dash-march speed */
  weight?: number
  /**
   * Which way traffic moves relative to source→target: agents call out to
   * accounts/MCPs, triggers fire in, chat integrations carry both ways.
   * Sets the dash-march direction; omitted for permission edges.
   */
  flow?: 'out' | 'in' | 'both'
  /** Endpoint is in a broken state (needs re-auth, errored, disconnected) — line renders red */
  broken?: boolean
  /**
   * The graph can remove the relationship behind this edge (unlink an
   * account/MCP, revoke an invoke permission). Trigger edges are not
   * deletable — that would delete the webhook/cron/chat itself.
   */
  deletable?: boolean
  /** Caller agent whose x-agent policies govern this edge — the edit target */
  policyAgentSlug?: string
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
 * Agent↔agent edges render as one straight line per unordered pair —
 * activity in either direction shares the segment (direction shows only in
 * the dash march), and a permission line is drawn only when no activity
 * line already occupies it. So pair-level state is keyed unordered.
 */
function countLabel(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

// Node-hover usage line, per resource kind.
const USAGE_UNIT: Record<ResourceKind, string> = {
  account: 'API call',
  mcp: 'tool call',
  chat: 'session',
  webhook: 'fire',
  cron: 'run',
}
const USAGE_IDLE: Record<ResourceKind, string> = {
  account: 'no calls yet',
  mcp: 'no calls yet',
  chat: 'no sessions yet',
  webhook: 'never fired',
  cron: 'never run',
}

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
  const accountStatus = new Map<string, ConnectedAccount['status']>()
  for (const account of input.accounts) {
    accountIds.add(account.id)
    accountStatus.set(account.id, account.status)
    nodes.push({
      id: nodeId.account(account.id),
      data: {
        kind: 'account',
        resourceId: account.id,
        label: account.displayName || account.provider?.displayName || account.toolkitSlug,
        status: account.status === 'active' ? 'connected' : account.status,
        tone: ACCOUNT_TONE[account.status] ?? 'muted',
        statusLabel: `${account.toolkitSlug} · ${account.status}`,
        iconSlug: account.toolkitSlug,
      },
    })
  }

  const mcpIds = new Set<string>()
  const mcpStatus = new Map<string, RemoteMcpServer['status']>()
  for (const mcp of input.mcps) {
    mcpIds.add(mcp.id)
    mcpStatus.set(mcp.id, mcp.status)
    nodes.push({
      id: nodeId.mcp(mcp.id),
      data: {
        kind: 'mcp',
        resourceId: mcp.id,
        label: mcp.name,
        status: mcp.status === 'active' ? 'connected' : mcp.status.replace('_', ' '),
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
    const calls = topology.accountUsage[`${link.agentSlug}:${link.accountId}`]
    const status = accountStatus.get(link.accountId)
    const problem = status === 'expired' ? 'needs re-auth' : status === 'revoked' ? 'revoked' : undefined
    edges.push({
      id: `${source}->${target}`,
      source,
      target,
      variant: 'resource',
      weight: calls,
      flow: 'out',
      broken: problem !== undefined,
      deletable: true,
    })
  }

  for (const link of topology.mcpLinks) {
    if (!agentSlugSet.has(link.agentSlug) || !mcpIds.has(link.mcpId)) continue
    const source = nodeId.agent(link.agentSlug)
    const target = nodeId.mcp(link.mcpId)
    const calls = topology.mcpUsage[`${link.agentSlug}:${link.mcpId}`]
    const status = mcpStatus.get(link.mcpId)
    const problem = status === 'auth_required' ? 'needs auth' : status === 'error' ? 'error' : undefined
    edges.push({
      id: `${source}->${target}`,
      source,
      target,
      variant: 'resource',
      weight: calls,
      flow: 'out',
      broken: problem !== undefined,
      deletable: true,
    })
  }

  for (const chat of topology.chats) {
    if (!agentSlugSet.has(chat.agentSlug)) continue
    const id = nodeId.chat(chat.id)
    const tone = chatTone(chat.status, chat.connected)
    nodes.push({
      id,
      data: {
        kind: 'chat',
        resourceId: chat.id,
        label: chat.name || chat.provider,
        status: chat.connected ? 'listening' : chat.status,
        tone,
        statusLabel: `${chat.provider} · ${chat.connected ? 'listening' : chat.status}`,
        iconSlug: chat.provider,
        agentSlug: chat.agentSlug,
      },
    })
    const source = nodeId.agent(chat.agentSlug)
    const problem = tone === 'error' ? 'error' : tone === 'attention' ? 'disconnected' : undefined
    edges.push({
      id: `${source}->${id}`,
      source,
      target: id,
      variant: 'trigger',
      weight: chat.sessionCount,
      // Messages arrive and replies go back — the one genuinely two-way link.
      flow: 'both',
      broken: problem !== undefined,
    })
  }

  for (const webhook of topology.webhooks) {
    if (!agentSlugSet.has(webhook.agentSlug)) continue
    const id = nodeId.webhook(webhook.id)
    const tone = AUTOMATION_TONE[webhook.status] ?? 'muted'
    nodes.push({
      id,
      data: {
        kind: 'webhook',
        resourceId: webhook.id,
        label: webhook.name || webhook.triggerType,
        status: webhook.status,
        tone,
        statusLabel: `webhook · ${webhook.status}`,
        agentSlug: webhook.agentSlug,
      },
    })
    const source = nodeId.agent(webhook.agentSlug)
    const problem = tone === 'error' ? 'failing' : undefined
    edges.push({
      id: `${source}->${id}`,
      source,
      target: id,
      variant: 'trigger',
      weight: webhook.fireCount,
      flow: 'in',
      broken: problem !== undefined,
    })
  }

  for (const task of topology.crons) {
    if (!agentSlugSet.has(task.agentSlug)) continue
    const id = nodeId.cron(task.id)
    const tone = AUTOMATION_TONE[task.status] ?? 'muted'
    // Unnamed tasks show the schedule AS the label, so no sublabel repeat.
    const schedule = task.isRecurring ? humanizeCron(task.scheduleExpression) : 'one-time'
    nodes.push({
      id,
      data: {
        kind: 'cron',
        resourceId: task.id,
        label: task.name || schedule,
        sublabel: task.name ? schedule : undefined,
        status: task.status,
        tone,
        statusLabel: `scheduled · ${task.status}`,
        agentSlug: task.agentSlug,
      },
    })
    const source = nodeId.agent(task.agentSlug)
    const problem = tone === 'error' ? 'failing' : undefined
    edges.push({
      id: `${source}->${id}`,
      source,
      target: id,
      variant: 'trigger',
      weight: task.executionCount,
      flow: 'in',
      broken: problem !== undefined,
    })
  }

  // Permissions per unordered pair (first caller wins as the edit target) —
  // consulted by both activity edges (delete = revoke the permission
  // underneath, if any) and the permission-edge pass below.
  const permissionCallerByPair = new Map<string, string>()
  for (const perm of topology.permissions) {
    if (perm.caller === perm.target) continue
    if (!agentSlugSet.has(perm.caller) || !agentSlugSet.has(perm.target)) continue
    const key = pairKey(perm.caller, perm.target)
    if (!permissionCallerByPair.has(key)) permissionCallerByPair.set(key, perm.caller)
  }

  // Merge invocations onto unordered pairs (A→B and B→A are visually one
  // line) but keep per-direction counts — the dash march runs toward the
  // invoked agent, or runs both ways on the line when both directions have
  // traffic. Then draw one activity edge per communicating pair…
  const activityByPair = new Map<string, { aToB: number; bToA: number }>()
  for (const inv of topology.invocations) {
    if (inv.caller === inv.target) continue
    if (!agentSlugSet.has(inv.caller) || !agentSlugSet.has(inv.target)) continue
    const key = pairKey(inv.caller, inv.target)
    const entry = activityByPair.get(key) ?? { aToB: 0, bToA: 0 }
    if (inv.caller === key.split('|')[0]) entry.aToB += inv.count
    else entry.bToA += inv.count
    activityByPair.set(key, entry)
  }
  for (const [key, { aToB, bToA }] of [...activityByPair].sort(([a], [b]) => a.localeCompare(b))) {
    const [a, b] = key.split('|')
    edges.push({
      id: `${nodeId.agent(a)}=${nodeId.agent(b)}`,
      source: nodeId.agent(a),
      target: nodeId.agent(b),
      variant: 'activity',
      weight: aToB + bToA,
      flow: aToB && bToA ? 'both' : aToB ? 'out' : 'in',
      // Activity is history — deleting the edge only revokes the standing
      // permission (when one exists); the recorded line stays.
      deletable: permissionCallerByPair.has(key),
      policyAgentSlug: permissionCallerByPair.get(key),
    })
  }

  // …and one idle permission edge per permitted-but-silent pair. Any
  // recorded activity supersedes the permission line: both would occupy the
  // same straight segment and double-draw.
  for (const [key, caller] of [...permissionCallerByPair].sort(([a], [b]) => a.localeCompare(b))) {
    if (activityByPair.has(key)) continue
    const [a, b] = key.split('|')
    edges.push({
      id: `${nodeId.agent(a)}~${nodeId.agent(b)}`,
      source: nodeId.agent(a),
      target: nodeId.agent(b),
      variant: 'permission',
      deletable: true,
      policyAgentSlug: caller,
    })
  }

  // Node-level usage: aggregate each resource's edge weights (a shared
  // account may serve several agents) — the hover pill's fine print.
  const weightByNode = new Map<string, number>()
  for (const edge of edges) {
    if (!edge.weight) continue
    weightByNode.set(edge.source, (weightByNode.get(edge.source) ?? 0) + edge.weight)
    weightByNode.set(edge.target, (weightByNode.get(edge.target) ?? 0) + edge.weight)
  }
  for (const node of nodes) {
    if (node.data.kind === 'agent') continue
    const total = weightByNode.get(node.id) ?? 0
    node.data.usage = total ? countLabel(total, USAGE_UNIT[node.data.kind]) : USAGE_IDLE[node.data.kind]
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
