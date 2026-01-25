import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiSecretDisplay } from '@shared/lib/types/api'

// Re-export for convenience
export type { ApiSecretDisplay }

export function useAgentSecrets(agentSlug: string | null) {
  return useQuery<ApiSecretDisplay[]>({
    queryKey: ['agent-secrets', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/secrets`)
      if (!res.ok) throw new Error('Failed to fetch secrets')
      return res.json()
    },
    enabled: !!agentSlug,
  })
}

export function useCreateSecret() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      agentSlug,
      key,
      value,
    }: {
      agentSlug: string
      key: string
      value: string
    }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to create secret')
      }
      return res.json() as Promise<ApiSecretDisplay>
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['agent-secrets', variables.agentSlug],
      })
    },
  })
}

export function useUpdateSecret() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      agentSlug,
      secretId,
      key,
      value,
    }: {
      agentSlug: string
      secretId: string
      key?: string
      value?: string
    }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/secrets/${secretId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to update secret')
      }
      return res.json() as Promise<ApiSecretDisplay>
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['agent-secrets', variables.agentSlug],
      })
    },
  })
}

export function useDeleteSecret() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      agentSlug,
      secretId,
    }: {
      agentSlug: string
      secretId: string
    }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/secrets/${secretId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to delete secret')
      }
      // 204 No Content - no body to parse
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['agent-secrets', variables.agentSlug],
      })
    },
  })
}
