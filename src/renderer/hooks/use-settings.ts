import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  GlobalSettingsResponse,
  ContainerSettings,
  AppPreferences,
  ModelSettings,
  AgentLimitsSettings,
  AuthSettings,
  VoiceSettings,
  AnalyticsTarget,
  LlmProviderId,
  WebProviderId,
  AgentCapabilitySettings,
  ModelConfigResponse,
} from '@shared/lib/config/settings'
import type { ComputerUseSettings } from '@shared/lib/computer-use/types'
import type { RunnerAvailability } from '@shared/lib/container/client-factory'
import type { RunnerSetupRemediation } from '@shared/lib/container/wsl2-setup-errors'
import type { ModelCatalogSettings, ModelSearchResult } from '@shared/lib/llm-provider'

export type { GlobalSettingsResponse, ContainerSettings, AppPreferences, ModelSettings, AgentLimitsSettings, AuthSettings, VoiceSettings, AnalyticsTarget, LlmProviderId, RunnerAvailability, RunnerSetupRemediation }

export function useModelConfig() {
  return useQuery<ModelConfigResponse>({
    queryKey: ['model-config'],
    queryFn: async () => {
      const res = await apiFetch('/api/settings/model-config')
      if (!res.ok) throw new Error('Failed to fetch model configuration')
      return res.json()
    },
    refetchInterval: 60000,
  })
}

export function useSettings(options?: { enabled?: boolean }) {
  return useQuery<GlobalSettingsResponse>({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await apiFetch('/api/settings')
      if (!res.ok) throw new Error('Failed to fetch settings')
      return res.json()
    },
    refetchInterval: 60000, // Poll less frequently - container status is cached server-side
    enabled: options?.enabled,
  })
}

export function useProviderModelSearch(
  providerId: LlmProviderId,
  query: string,
  options?: { enabled?: boolean },
) {
  const trimmedQuery = query.trim()
  return useQuery<ModelSearchResult[]>({
    queryKey: ['settings', 'llm-provider-model-search', providerId, trimmedQuery],
    queryFn: async () => {
      const res = await apiFetch(
        `/api/settings/llm-providers/${providerId}/models/search?q=${encodeURIComponent(trimmedQuery)}`,
      )
      const body = await res.json().catch(() => ({})) as { data?: ModelSearchResult[]; error?: string }
      if (!res.ok) throw new Error(body.error || 'Failed to search provider models')
      return Array.isArray(body.data) ? body.data : []
    },
    enabled: options?.enabled !== false && trimmedQuery.length >= 2,
    staleTime: 5 * 60 * 1000,
  })
}

export interface UpdateSettingsParams {
  container?: Partial<ContainerSettings>
  app?: Omit<Partial<AppPreferences>, 'faviconDataUrl'> & { faviconDataUrl?: string | null }
  llmProvider?: LlmProviderId
  // null clears to auto-resolve (server stores undefined).
  webProvider?: WebProviderId | null
  apiKeys?: {
    anthropicApiKey?: string
    openrouterApiKey?: string
    genericApiKey?: string
    genericBaseUrl?: string
    bedrockApiKey?: string
    bedrockAccessKeyId?: string
    bedrockSecretAccessKey?: string
    bedrockRegion?: string
    composioApiKey?: string
    composioUserId?: string
    browserbaseApiKey?: string
    browserbaseProjectId?: string
    deepgramApiKey?: string
    openaiApiKey?: string
    nangoSecretKey?: string
    accountProviderUserId?: string
    exaApiKey?: string
  }
  models?: Partial<ModelSettings>
  modelCatalog?: ModelCatalogSettings
  agentLimits?: Partial<AgentLimitsSettings>
  customEnvVars?: Record<string, string>
  auth?: Partial<AuthSettings>
  voice?: Partial<VoiceSettings>
  computerUse?: Partial<ComputerUseSettings>
  shareAnalytics?: boolean
  analyticsTargets?: AnalyticsTarget[]
  shareErrorReports?: boolean
  enableToolSearch?: boolean
  agentCapabilities?: Partial<AgentCapabilitySettings>
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
      queryClient.invalidateQueries({ queryKey: ['model-config'] })
    },
  })
}

export interface StartRunnerResponse {
  success: boolean
  message: string
  runnerAvailability?: RunnerAvailability[]
  setupError?: RunnerSetupRemediation
}

/** Error thrown by useStartRunner when the server returns a typed setup failure. */
export class RunnerSetupFailedError extends Error {
  readonly setupError: RunnerSetupRemediation
  constructor(setupError: RunnerSetupRemediation) {
    super(setupError.title)
    this.name = 'RunnerSetupFailedError'
    this.setupError = setupError
  }
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
      window.localStorage.removeItem('superagent-auth-choice')
      queryClient.invalidateQueries()
    },
  })
}

export function useRefreshAvailability() {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async () => {
      const res = await apiFetch('/api/settings/refresh-availability', {
        method: 'POST',
      })
      if (!res.ok) throw new Error('Failed to refresh availability')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
  })
}

export function useStartRunner() {
  const queryClient = useQueryClient()
  const { data: settings } = useSettings()

  const mutation = useMutation<StartRunnerResponse, Error, string>({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (runner) => {
      const res = await apiFetch('/api/settings/start-runner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runner }),
      })

      const data = await res.json()

      if (!res.ok) {
        if (Array.isArray(data?.runnerAvailability)) {
          queryClient.setQueryData(['settings'], (old: unknown) => {
            if (!old || typeof old !== 'object') return old
            return { ...old, runnerAvailability: data.runnerAvailability }
          })
        }
        if (data?.setupError) {
          throw new RunnerSetupFailedError(data.setupError)
        }
        throw new Error(data.message || data.error || 'Failed to start runner')
      }

      return data
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
  })

  const activeRunner = mutation.variables
  const readinessStatus = settings?.runtimeReadiness?.status
  const isProvisioning = (runner: string) =>
    activeRunner === runner &&
    (mutation.isPending ||
      readinessStatus === 'CHECKING' ||
      readinessStatus === 'PULLING_IMAGE')

  // Drop stale cancel/fail once that runner is available (other surface may have succeeded).
  const displayError =
    activeRunner &&
    settings?.runnerAvailability?.some((r) => r.runner === activeRunner && r.available)
      ? null
      : mutation.error

  return { ...mutation, isProvisioning, displayError }
}

export function useRestartRunner() {
  const queryClient = useQueryClient()

  return useMutation<StartRunnerResponse, Error, string>({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (runner) => {
      // Immediately invalidate so the next poll sees the runner as stopped
      queryClient.invalidateQueries({ queryKey: ['settings'] })

      const res = await apiFetch('/api/settings/restart-runner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runner }),
      })

      const data = await res.json()

      if (!res.ok) {
        if (data?.setupError) {
          throw new RunnerSetupFailedError(data.setupError)
        }
        throw new Error(data.message || data.error || 'Failed to restart runner')
      }

      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
  })
}
