import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { GlobalSettingsResponse } from '@/app/api/settings/route'
import type { ContainerSettings } from '@/lib/config/settings'
import type { RunnerAvailability } from '@/lib/container/client-factory'

export type { GlobalSettingsResponse, ContainerSettings, RunnerAvailability }

export function useSettings() {
  return useQuery<GlobalSettingsResponse>({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings')
      if (!res.ok) throw new Error('Failed to fetch settings')
      return res.json()
    },
    refetchInterval: 5000, // Poll to check for running agents status changes
  })
}

export interface UpdateSettingsParams {
  container?: Partial<ContainerSettings>
}

export interface UpdateSettingsError {
  error: string
  runningAgents?: string[]
}

export function useUpdateSettings() {
  const queryClient = useQueryClient()

  return useMutation<GlobalSettingsResponse, UpdateSettingsError, UpdateSettingsParams>({
    mutationFn: async (data) => {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!res.ok) {
        const error = await res.json()
        throw error
      }

      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
  })
}
