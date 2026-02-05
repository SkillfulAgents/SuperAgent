import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  GlobalSettingsResponse,
  ContainerSettings,
  AppPreferences,
  ModelSettings,
} from '@shared/lib/config/settings'
import type { RunnerAvailability } from '@shared/lib/container/client-factory'

export type { GlobalSettingsResponse, ContainerSettings, AppPreferences, ModelSettings, RunnerAvailability }

export function useSettings() {
  return useQuery<GlobalSettingsResponse>({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await apiFetch('/api/settings')
      if (!res.ok) throw new Error('Failed to fetch settings')
      return res.json()
    },
    refetchInterval: 5000, // Poll to check for running agents status changes
  })
}

export interface UpdateSettingsParams {
  container?: Partial<ContainerSettings>
  app?: Partial<AppPreferences>
  apiKeys?: {
    anthropicApiKey?: string
    composioApiKey?: string
    composioUserId?: string
  }
  models?: Partial<ModelSettings>
}

export interface UpdateSettingsError {
  error: string
  runningAgents?: string[]
}

export function useUpdateSettings() {
  const queryClient = useQueryClient()

  return useMutation<GlobalSettingsResponse, UpdateSettingsError, UpdateSettingsParams>({
    mutationFn: async (data) => {
      const res = await apiFetch('/api/settings', {
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

export interface StartRunnerResponse {
  success: boolean
  message: string
  runnerAvailability?: RunnerAvailability[]
}

export function useFactoryReset() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/api/settings/factory-reset', {
        method: 'POST',
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Factory reset failed')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries()
    },
  })
}

export function useStartRunner() {
  const queryClient = useQueryClient()

  return useMutation<StartRunnerResponse, Error, 'docker' | 'podman'>({
    mutationFn: async (runner) => {
      const res = await apiFetch('/api/settings/start-runner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runner }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to start runner')
      }

      return data
    },
    onSuccess: () => {
      // Invalidate settings to refresh runner availability
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
  })
}
