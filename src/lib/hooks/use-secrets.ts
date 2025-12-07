import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

// Secret type without the actual value (for display)
export interface AgentSecretDisplay {
  id: string
  key: string
  envVar: string
  createdAt: Date
  updatedAt: Date
}

export function useAgentSecrets(agentId: string | null) {
  return useQuery<AgentSecretDisplay[]>({
    queryKey: ['agent-secrets', agentId],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${agentId}/secrets`)
      if (!res.ok) throw new Error('Failed to fetch secrets')
      return res.json()
    },
    enabled: !!agentId,
  })
}

export function useCreateSecret() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      agentId,
      key,
      value,
    }: {
      agentId: string
      key: string
      value: string
    }) => {
      const res = await fetch(`/api/agents/${agentId}/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to create secret')
      }
      return res.json()
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['agent-secrets', variables.agentId],
      })
    },
  })
}

export function useUpdateSecret() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      agentId,
      secretId,
      key,
      value,
    }: {
      agentId: string
      secretId: string
      key?: string
      value?: string
    }) => {
      const res = await fetch(`/api/agents/${agentId}/secrets/${secretId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to update secret')
      }
      return res.json()
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['agent-secrets', variables.agentId],
      })
    },
  })
}

export function useDeleteSecret() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      agentId,
      secretId,
    }: {
      agentId: string
      secretId: string
    }) => {
      const res = await fetch(`/api/agents/${agentId}/secrets/${secretId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to delete secret')
      }
      return res.json()
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['agent-secrets', variables.agentId],
      })
    },
  })
}
