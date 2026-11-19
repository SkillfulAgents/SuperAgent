import { queryOptions } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'

interface PolicyRow {
  id: string
  operation: 'list' | 'read' | 'invoke'
  targetAgentSlug: string | null
  targetAgentName: string | null
  decision: 'allow' | 'review' | 'block'
  updatedAt: string
}

export function agentPoliciesQuery(slug: string) {
  return queryOptions({
    queryKey: ['x-agent-policies', slug],
    queryFn: async (): Promise<{ policies: PolicyRow[] }> => {
      const response = await apiFetch(`/api/agents/${encodeURIComponent(slug)}/x-agent-policies`)
      if (!response.ok) throw new Error('Failed to fetch policies')
      return response.json()
    },
  })
}

/** A target-specific policy takes precedence over the caller's global policy. */
export function effectiveAgentPolicy(policies: PolicyRow[], operation: 'read' | 'invoke', target: string) {
  return policies.find(p => p.operation === operation && p.targetAgentSlug === target)?.decision
    ?? policies.find(p => p.operation === operation && p.targetAgentSlug === null)?.decision
    ?? 'review'
}
