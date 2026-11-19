import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { agentShareRosterSchema, directMemberAgentsSchema, type MemberAgent } from '@shared/lib/types/agent-sharing'

// Graph edits and member notifications refresh both the stacks and any open roster.
export const AGENT_MEMBER_AGENTS_QUERY_KEY = ['home-graph', 'member-agents'] as const
const NONE: MemberAgent[] = []

async function loadAgentShareRoster(agentSlug: string, signal: AbortSignal) {
  const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug)}/member-agents`, { signal })
  if (res.status === 404) return { direct: [], global: [] }
  if (!res.ok) throw new Error('Could not load agent members')
  return agentShareRosterSchema.parse(await res.json())
}

export function useAgentMemberAgents(agentSlug: string, unlisted = false) {
  const { data } = useQuery({
    queryKey: unlisted ? [...AGENT_MEMBER_AGENTS_QUERY_KEY, agentSlug, 'stack'] : AGENT_MEMBER_AGENTS_QUERY_KEY,
    queryFn: async ({ signal }) => {
      if (unlisted) return { [agentSlug]: (await loadAgentShareRoster(agentSlug, signal)).direct }
      const res = await apiFetch('/api/agents/member-agents', { signal })
      if (res.status === 404) return {} as Record<string, MemberAgent[]>
      if (!res.ok) throw new Error('Could not load agent members')
      return directMemberAgentsSchema.parse(await res.json())
    },
    select: byAgent => byAgent[agentSlug] ?? NONE,
    staleTime: 30_000,
  })
  return data ?? NONE
}

export function useAgentShareRoster(agentSlug: string) {
  return useQuery({
    queryKey: [...AGENT_MEMBER_AGENTS_QUERY_KEY, agentSlug],
    queryFn: ({ signal }) => loadAgentShareRoster(agentSlug, signal),
  })
}
