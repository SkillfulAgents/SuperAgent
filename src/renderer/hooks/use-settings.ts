import { apiFetch } from '@renderer/lib/api'
import { HttpError } from '@renderer/lib/http-error'
import { useUser } from '@renderer/context/user-context'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { MODEL_CATALOG_QUERY_KEY, MODEL_CATALOG_STALE_TIME, invalidateModelCatalog, settingsPatchChangesModelCatalog } from '@renderer/lib/model-catalog-query'
import type {
  GlobalSettingsResponse,
  ModelPickerSettingsResponse,
  ContainerSettings,
  AppPreferences,
  ModelSettings,
  AgentLimitsSettings,
  AuthSettings,
  VoiceSettings,
  AnalyticsTarget,
  LlmProviderId,
} from '@shared/lib/config/settings'
import type { SettingsPatch } from '@shared/lib/config/settings-patch'
import type { RunnerAvailability } from '@shared/lib/container/client-factory'
import type { RunnerSetupRemediation } from '@shared/lib/container/wsl2-setup-errors'
import type { ModelSearchResult } from '@shared/lib/llm-provider'

export type { GlobalSettingsResponse, ModelPickerSettingsResponse, ContainerSettings, AppPreferences, ModelSettings, AgentLimitsSettings, AuthSettings, VoiceSettings, AnalyticsTarget, LlmProviderId, RunnerAvailability, RunnerSetupRemediation }

/** The server's refusal of a signed-in user who is not an admin. */
function isForbidden(error: unknown): boolean {
  return error instanceof HttpError && error.status === 403
}

const SETTINGS_POLL_MS = 60_000

/**
 * The global settings. `GET /api/settings` is admin-only in auth mode, so the
 * query is off for everyone else there (and until the session says who is
 * asking): `data` stays undefined and `isLoading` stays false, with no request.
 * A 403 that still arrives (a role revoked since the session was read) is not
 * retried and stops the poll.
 */
export function useSettings(options?: { enabled?: boolean }) {
  const { isAuthMode, isAdmin } = useUser()
  const mayRead = !isAuthMode || isAdmin
  return useQuery<GlobalSettingsResponse>({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await apiFetch('/api/settings')
      if (!res.ok) throw new HttpError(res.status, 'Failed to fetch settings')
      return res.json()
    },
    // Poll less frequently - container status is cached server-side
    refetchInterval: (query) => (isForbidden(query.state.error) ? false : SETTINGS_POLL_MS),
    // Settings writes invalidate this and readiness arrives on the
    // notifications stream, so a new observer reuses what is cached instead of
    // refetching on every navigation and Settings tab (the 5 s default). The
    // window is the poll's interval and no longer: nothing announces another
    // admin's write or a change in the host-derived fields (runner
    // availability, host browser status), so a mount after it reads again.
    staleTime: SETTINGS_POLL_MS,
    // Back online is read again as before, without waiting out the window.
    refetchOnReconnect: 'always',
    retry: (failureCount, error) => !isForbidden(error) && failureCount < 3,
    enabled: mayRead && (options?.enabled ?? true),
  })
}

/**
 * The global guidance appended to every agent's system prompt. Readable by
 * every signed-in user (unlike `useSettings()`); admins write it through
 * `useUpdateSettings()`, whose `['settings']` invalidation refreshes this.
 */
export function useGlobalInstructions() {
  return useQuery<{ globalInstructions: string }>({
    queryKey: ['settings', 'global-instructions'],
    queryFn: async () => {
      const res = await apiFetch('/api/settings/global-instructions')
      if (!res.ok) throw new Error('Failed to fetch global guidance')
      return res.json()
    },
  })
}

/** Default-on preference; treat missing as enabled. */
export function isWarmStartOnTypeEnabled(
  settings?: Pick<GlobalSettingsResponse, 'app'> | null,
): boolean {
  return settings?.app?.warmStartOnType !== false
}

/** Default-on MicroVM preference; treat missing as enabled. */
export function isAutoResumeOnUnexpectedDeathEnabled(
  settings?: Pick<GlobalSettingsResponse, 'app'> | null,
): boolean {
  return settings?.app?.autoResumeOnUnexpectedDeath !== false
}

/**
 * Whether warm-start-on-type should fire. Returns false until settings have
 * loaded so a disabled preference cannot race a speculative start.
 */
export function useWarmStartOnTypeEnabled(): boolean {
  const { data, isSuccess } = useSettings()
  if (!isSuccess) return false
  return isWarmStartOnTypeEnabled(data)
}

/**
 * Picker-safe model settings served to EVERY authenticated user. The composer
 * and default-model pickers must read this — not `useSettings()`, whose
 * endpoint is admin-gated in auth mode and leaves non-admins with an empty
 * catalog.
 *
 * Two reads, cached apart. The catalog (`GET /api/settings/models`, over
 * 100 KB) is the same for every agent, so every caller shares one entry, kept
 * out of the `['settings']` prefix: see `model-catalog-query.ts` for what
 * refreshes it. An agent's saved connections keep the `['settings', 'models',
 * …]` key, so the broad settings invalidations still refresh them. With an
 * agent, `data` is the catalog with that agent's connections in place of the
 * viewer's, and is undefined until both are read.
 */
export function useModelSettings(agentSlug?: string, llmProviderId?: string | null) {
  const catalog = useQuery<ModelPickerSettingsResponse>({
    queryKey: MODEL_CATALOG_QUERY_KEY,
    queryFn: async () => {
      const res = await apiFetch('/api/settings/models')
      if (!res.ok) throw new Error('Failed to fetch model settings')
      return res.json()
    },
    staleTime: MODEL_CATALOG_STALE_TIME,
  })
  const saved = useQuery<ModelPickerSettingsResponse['connections']>({
    queryKey: ['settings', 'models', agentSlug, llmProviderId],
    queryFn: async () => {
      const query = llmProviderId ? `?llmProviderId=${encodeURIComponent(llmProviderId)}` : ''
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug ?? '')}/llm-connections${query}`)
      if (!res.ok) throw new Error('Failed to fetch saved model connection')
      return (await res.json()).connections
    },
    enabled: !!agentSlug,
    staleTime: 60000,
  })
  const data = useMemo(() => {
    if (!catalog.data || !agentSlug) return catalog.data
    return saved.data ? { ...catalog.data, connections: saved.data } : undefined
  }, [catalog.data, saved.data, agentSlug])
  // A failed settings read wins over a failed connection read.
  const error = catalog.error ?? (agentSlug ? saved.error : null)
  return {
    data,
    error,
    isError: error !== null,
    isSuccess: error === null && data !== undefined,
    isLoading: catalog.isLoading || (!!agentSlug && saved.isLoading),
  }
}

export function useProviderModelSearch(
  providerId: LlmProviderId,
  query: string,
  options?: { enabled?: boolean; llmProviderId?: string },
) {
  const trimmedQuery = query.trim()
  return useQuery<ModelSearchResult[]>({
    queryKey: ['settings', 'llm-provider-model-search', providerId, options?.llmProviderId, trimmedQuery],
    queryFn: async () => {
      const res = await apiFetch(
        options?.llmProviderId
          ? `/api/llm-connections/${encodeURIComponent(options.llmProviderId)}/models/search?q=${encodeURIComponent(trimmedQuery)}`
          : `/api/settings/llm-providers/${providerId}/models/search?q=${encodeURIComponent(trimmedQuery)}`,
      )
      const body = await res.json().catch(() => ({})) as { data?: ModelSearchResult[]; error?: string }
      if (!res.ok) throw new Error(body.error || 'Failed to search provider models')
      return Array.isArray(body.data) ? body.data : []
    },
    enabled: options?.enabled !== false && trimmedQuery.length >= 2,
    staleTime: 5 * 60 * 1000,
  })
}

/** Inferred from the same runtime schema enforced by PUT /api/settings. */
export type UpdateSettingsParams = SettingsPatch

export interface UpdateSettingsError {
  error: string
  runningAgents?: string[]
  status: number
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
        const error: UpdateSettingsError = { ...(await res.json()), status: res.status }
        throw error
      }

      return res.json()
    },
    onSuccess: (_result, patch) => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      if (settingsPatchChangesModelCatalog(patch)) void invalidateModelCatalog(queryClient)
      queryClient.invalidateQueries({ queryKey: ['runtime-status'] })
      // Voice provider / key / default voice live in these settings, and the
      // speaker buttons and Voice tab gate on the derived status.
      queryClient.invalidateQueries({ queryKey: ['voice-configured'] })
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
