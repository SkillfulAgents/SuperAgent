import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { curatorResponseSchema, type CuratorResponse } from '@shared/lib/types/brain-schema'

export const BRAIN_CURATOR_QUERY_KEY = ['brain-curator'] as const

export type BrainCuratorState = CuratorResponse

export function useBrainCurator() {
  return useQuery<BrainCuratorState>({
    queryKey: BRAIN_CURATOR_QUERY_KEY,
    queryFn: async () => {
      const res = await apiFetch('/api/brain/curator')
      if (!res.ok) throw new Error('Failed to fetch Team Brain curator')
      return curatorResponseSchema.parse(await res.json())
    },
  })
}

export function useSetBrainCurator() {
  const queryClient = useQueryClient()
  return useMutation<BrainCuratorState, Error, string | null>({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (agentSlug) => {
      const res = await apiFetch('/api/brain/curator', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentSlug }),
      })
      if (!res.ok) throw new Error('Failed to update Team Brain curator')
      return curatorResponseSchema.parse(await res.json())
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: BRAIN_CURATOR_QUERY_KEY })
    },
  })
}
