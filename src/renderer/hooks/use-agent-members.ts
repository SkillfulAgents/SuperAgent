import { useQuery, useQueryClient } from '@tanstack/react-query'
import { loadAgentMembers } from '@renderer/lib/agent-members-loader'
import { useUser } from '@renderer/context/user-context'

/** Sidebar, header, and sharing pane reuse the same live roster per agent. */
export function useAgentMembers(agentSlug: string, enabled = true) {
  const { isAuthMode } = useUser()
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: ['agent-members', agentSlug],
    queryFn: ({ signal }) => loadAgentMembers(queryClient, agentSlug, signal),
    enabled: isAuthMode && enabled,
    staleTime: 30_000,
  })
}
