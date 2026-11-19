import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { finishedSetupSchema } from '@shared/lib/agent-integrations/finished-setup-schema'
import type { AgentIntegrationProvider } from '@shared/lib/agent-integrations/provider-types'
import { apiFetch } from '@renderer/lib/api'
import { agentIntegrationKeys } from './use-agent-integrations'

// A completed installation invalidates this list along with the agent's integrations.
const key = (slug: string) => [...agentIntegrationKeys.lists(slug), 'finished-setup'] as const
const path = (slug: string) => `/api/agent-integrations/agents/${encodeURIComponent(slug)}/finished-setup`

export function useFinishedSetup(slug: string) {
  return useQuery({
    queryKey: key(slug),
    queryFn: async () => {
      const res = await apiFetch(path(slug))
      if (!res.ok) throw new Error('Could not load pending agent setup')
      return finishedSetupSchema.parse(await res.json())
    },
  })
}

export function useSetChannelDeferred(slug: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async ({ provider, deferred }: { provider: AgentIntegrationProvider; deferred: boolean }) => {
      const res = await apiFetch(`${path(slug)}/${provider}`, { method: deferred ? 'PUT' : 'DELETE' })
      if (!res.ok) throw new Error(deferred ? 'Could not save the setup reminder' : 'Could not dismiss the setup reminder')
    },
    onSuccess: () => client.invalidateQueries({ queryKey: key(slug) }),
  })
}
