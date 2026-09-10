import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useUser } from '@renderer/context/user-context'
import { agentMembersSchema } from '@shared/lib/agent-members-schema'

/** The header and sharing pane share one current-agent roster. */
export function useAgentMembers(agentSlug: string, enabled = true) {
  const { isAuthMode } = useUser()
  return useQuery({
    queryKey: ['agent-members', agentSlug],
    queryFn: async () => {
      const response = await apiFetch(`/api/agents/${agentSlug}/members`)
      if (!response.ok) throw new Error('Could not load members')
      return agentMembersSchema.parse(await response.json())
    },
    enabled: isAuthMode && enabled,
    staleTime: 30_000,
  })
}
