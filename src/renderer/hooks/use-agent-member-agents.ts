import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import {
  agentMemberAgentsByAgentSchema,
  type AgentMemberAgent,
  type AgentMemberAgentsByAgent,
} from '@shared/lib/types/inbound-x-agent-schema'

/** Under the home graph's key, so whatever refreshes the graph after a link change refreshes the stacks too. */
export const AGENT_MEMBER_AGENTS_QUERY_KEY = ['home-graph', 'member-agents'] as const

const NONE: AgentMemberAgent[] = []

/**
 * The other agents that have a role on this one, for its member stack. Every
 * stack shares one request for all agents, and `select` hands each its own
 * list, so a change to one agent's members re-renders that agent's stack only.
 */
export function useAgentMemberAgents(agentSlug: string): AgentMemberAgent[] {
  const { data } = useQuery<AgentMemberAgentsByAgent, Error, AgentMemberAgent[]>({
    queryKey: AGENT_MEMBER_AGENTS_QUERY_KEY,
    queryFn: async () => {
      const response = await apiFetch('/api/agents/member-agents')
      if (!response.ok) throw new Error('Failed to fetch member agents')
      return agentMemberAgentsByAgentSchema.parse(await response.json())
    },
    select: (byAgent) => byAgent[agentSlug] ?? NONE,
    staleTime: 30_000,
  })
  return data ?? NONE
}
