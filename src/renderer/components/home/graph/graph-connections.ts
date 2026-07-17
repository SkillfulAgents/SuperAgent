/**
 * The real relationships behind drawn/deleted graph edges.
 *
 * A drawn edge must create the relationship it depicts: an invoke
 * permission for agent→agent, an account/MCP link for agent↔resource.
 * Webhooks, crons and chat integrations can't be drawn — they're created
 * through their own forms (their ports aren't connectable either).
 * Deleting an edge removes the relationship (never the history).
 */

import { toast } from 'sonner'
import { apiFetch } from '@renderer/lib/api'
import type { GraphEdgeSpec } from './use-graph-data'

export function nodeKind(nodeId: string): string {
  return nodeId.slice(0, nodeId.indexOf(':'))
}

export function nodeRef(nodeId: string): string {
  return nodeId.slice(nodeId.indexOf(':') + 1)
}

export function drawnConnectionKind(source: string, target: string): 'invoke' | 'account' | 'mcp' | null {
  const kinds = [nodeKind(source), nodeKind(target)].sort()
  if (kinds[0] === 'agent' && kinds[1] === 'agent') return source !== target ? 'invoke' : null
  if (kinds[0] === 'account' && kinds[1] === 'agent') return 'account'
  if (kinds[0] === 'agent' && kinds[1] === 'mcp') return 'mcp'
  return null
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

/**
 * Remove the relationship behind an edge; true = something changed.
 * Resource edges unlink the account/MCP; agent↔agent edges revoke invoke
 * permissions in both directions (invocation history is untouched).
 */
export async function deleteGraphConnection(edge: GraphEdgeSpec): Promise<boolean> {
  try {
    if (edge.variant === 'resource') {
      // Resource edges are always built agent → resource.
      const slug = nodeRef(edge.source)
      const resourceKind = nodeKind(edge.target)
      const resourceId = nodeRef(edge.target)
      const res = await apiFetch(
        resourceKind === 'account'
          ? `/api/agents/${slug}/connected-accounts/${resourceId}`
          : `/api/agents/${slug}/remote-mcps/${resourceId}`,
        { method: 'DELETE' },
      )
      if (!res.ok) throw new Error(`Failed to unlink (${res.status})`)
      toast.success(resourceKind === 'account' ? 'Account unlinked' : 'MCP server unlinked')
      return true
    }
    // Atomic per-target revoke of every direction the user can edit (the
    // drawn line is unordered; buildGraph pre-filtered `policyCallers` to
    // directions with a policy row on a caller the user admins). Directions
    // are independent: one failing must not abort the rest, and any success
    // must still report `changed` so the graph refetches — otherwise a
    // half-removed pair renders stale. The endpoint PRESERVES explicit
    // 'block' rows — removing grants must never lift a block and escalate.
    const a = nodeRef(edge.source)
    const b = nodeRef(edge.target)
    let changed = false
    let failed = false
    for (const caller of edge.policyCallers ?? []) {
      const target = caller === a ? b : a
      try {
        const res = await apiFetch(
          `/api/agents/${caller}/x-agent-policies/invoke/${encodeURIComponent(target)}`,
          { method: 'DELETE' },
        )
        if (!res.ok) throw new Error(`Failed to revoke permission (${res.status})`)
        const { removed } = (await res.json()) as { removed: number }
        if (removed > 0) changed = true
      } catch (error) {
        console.error('Failed to revoke permission:', error)
        failed = true
      }
    }
    if (failed) toast.error(changed ? "Couldn't remove every direction of the connection" : "Couldn't remove the connection")
    else if (changed) toast.success('Invoke permission revoked')
    return changed
  } catch (error) {
    console.error('Failed to delete connection:', error)
    toast.error("Couldn't remove the connection")
    return false
  }
}

/** Create the relationship behind a drawn edge; true = something changed. */
export async function createDrawnConnection(source: string, target: string): Promise<boolean> {
  const kind = drawnConnectionKind(source, target)
  if (!kind) return false
  try {
    if (kind === 'invoke') {
      // Drag direction = permission direction: source may invoke target.
      // Atomic single-policy upsert — the whole-list GET+replace round-trip
      // was O(policy count) and lost concurrent edits (last PUT wins).
      const caller = nodeRef(source)
      const targetSlug = nodeRef(target)
      const res = await apiFetch(
        `/api/agents/${caller}/x-agent-policies/invoke/${encodeURIComponent(targetSlug)}`,
        { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ decision: 'allow' }) },
      )
      if (!res.ok) throw new Error(`Failed to save policy (${res.status})`)
      const { created, previousDecision } = (await res.json()) as {
        created: boolean
        previousDecision: 'allow' | 'review' | 'block' | null
      }
      if (!created && previousDecision === 'allow') {
        toast.info('These agents are already connected')
        return false
      }
      // A pre-existing 'block' (invisible on the graph — block edges aren't
      // drawn) is deliberately replaced: the user just drew the connection.
      toast.success(previousDecision === 'block' ? 'Invoke permission added (replaced block)' : 'Invoke permission added')
      return true
    }
    const agentNodeId = nodeKind(source) === 'agent' ? source : target
    const resourceNodeId = agentNodeId === source ? target : source
    const slug = nodeRef(agentNodeId)
    const resourceId = nodeRef(resourceNodeId)
    const res =
      kind === 'account'
        ? await apiFetch(`/api/agents/${slug}/connected-accounts`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ accountIds: [resourceId] }),
          })
        : await apiFetch(`/api/agents/${slug}/remote-mcps`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ mcpIds: [resourceId] }),
          })
    if (!res.ok) throw new Error(`Failed to link (${res.status})`)
    toast.success(kind === 'account' ? 'Account linked to agent' : 'MCP server linked to agent')
    return true
  } catch (error) {
    console.error('Failed to create connection:', error)
    toast.error("Couldn't create the connection")
    return false
  }
}
