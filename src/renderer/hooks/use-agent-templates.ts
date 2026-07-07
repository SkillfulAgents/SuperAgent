import { useEffect, useRef } from 'react'
import { apiFetch } from '@renderer/lib/api'
import { uploadFileChunked, type UploadProgress } from '@renderer/lib/upload'
import { downloadBlob } from '@renderer/lib/download'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useSkillsets } from '@renderer/hooks/use-skillsets'
import type { ApiAgent, ApiDiscoverableAgent, ApiItemStatus } from '@shared/lib/types/api'
import { AGENT_PACKAGE_EXTENSION } from '@shared/lib/utils/package-extensions'

// Alias preserves the prior export name for downstream consumers while we
// route everything through the canonical `ApiItemStatus`.
type ApiAgentTemplateStatus = ApiItemStatus

// Module-level flag ensures the background refresh fires only once across all
// component instances that call useDiscoverableAgents().
let refreshPromise: Promise<void> | null = null

/**
 * Fetch discoverable agents from skillsets.
 * The queryFn returns cached data first (fast). On the first call app-wide,
 * a single background refresh is kicked off; when it resolves with new data
 * the query cache is updated so every consumer re-renders.
 */
export function useDiscoverableAgents() {
  const queryClient = useQueryClient()
  const { data: skillsets } = useSkillsets()
  const hasSkillsets = !!(skillsets && skillsets.length > 0)

  return useQuery<ApiDiscoverableAgent[]>({
    queryKey: ['discoverable-agents'],
    enabled: hasSkillsets,
    queryFn: async () => {
      const res = await apiFetch('/api/agents/discoverable-agents')
      if (!res.ok) throw new Error('Failed to fetch discoverable agents')
      const data = await res.json()
      const agents = data.agents as ApiDiscoverableAgent[]

      // Kick off a single background refresh the first time any component fetches
      if (!refreshPromise) {
        refreshPromise = apiFetch('/api/agents/discoverable-agents?refresh=true')
          .then(async (refreshRes) => {
            if (refreshRes.ok) {
              const refreshData = await refreshRes.json()
              const refreshed = refreshData.agents as ApiDiscoverableAgent[]
              if (JSON.stringify(refreshed) !== JSON.stringify(agents)) {
                queryClient.setQueryData(['discoverable-agents'], refreshed)
              }
            }
          })
          .catch(() => { /* ignore background refresh failures */ })
      }

      return agents
    },
  })
}

export function useExportAgentTemplate() {
  const { track } = useAnalyticsTracking()

  return useMutation<void, Error, { agentSlug: string; agentName: string }>({
    mutationFn: async ({ agentSlug, agentName }) => {
      track('template_exported')
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug)}/export-template`, {
        method: 'POST',
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to export template')
      }

      await downloadBlob(res, `${agentName || agentSlug}-template${AGENT_PACKAGE_EXTENSION}`)
    },
  })
}

export function useExportAgentFull() {
  const { track } = useAnalyticsTracking()

  return useMutation<void, Error, { agentSlug: string; agentName: string }>({
    mutationFn: async ({ agentSlug, agentName }) => {
      track('agent_full_exported')
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug)}/export-full`, {
        method: 'POST',
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to export agent')
      }

      await downloadBlob(res, `${agentName || agentSlug}-full${AGENT_PACKAGE_EXTENSION}`)
    },
  })
}

export type ImportProgress = UploadProgress

export function useImportAgentTemplate() {
  const queryClient = useQueryClient()
  const { track } = useAnalyticsTracking()

  return useMutation<
    ApiAgent & { hasOnboarding?: boolean },
    Error,
    { file: File; mode?: 'template' | 'full'; onProgress?: (p: ImportProgress) => void }
  >({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ file, mode, onProgress }) => {
      return uploadFileChunked<ApiAgent & { hasOnboarding?: boolean }>({
        url: '/api/agents/import-template',
        file,
        fields: { mode: mode || 'template' },
        onProgress,
      })
    },
    onSuccess: () => {
      track('agent_created', { source: 'file_import' })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['my-agent-roles'] })
    },
  })
}

export function useInstallAgentFromSkillset() {
  const queryClient = useQueryClient()
  const { track } = useAnalyticsTracking()

  return useMutation<
    ApiAgent & { hasOnboarding?: boolean },
    Error,
    {
      skillsetId: string
      agentPath: string
      agentName: string
      agentVersion: string
    }
  >({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ skillsetId, agentPath, agentName, agentVersion }) => {
      const res = await apiFetch('/api/agents/install-from-skillset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillsetId, agentPath, agentName, agentVersion }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to install agent from skillset')
      }
      return res.json()
    },
    onSuccess: () => {
      track('agent_created', { source: 'skillset' })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['discoverable-agents'] })
      queryClient.invalidateQueries({ queryKey: ['my-agent-roles'] })
    },
  })
}

// Tracks slugs whose session-scoped background refresh has already fired,
// so we don't hammer the refresh endpoint on every remount. Cleared on
// full page reload.
const templateRefreshSet = new Set<string>()

function statusesEqual(a: ApiAgentTemplateStatus, b: ApiAgentTemplateStatus): boolean {
  if (a === b) return true
  return (
    a.type === b.type
    && a.skillsetId === b.skillsetId
    && a.skillsetName === b.skillsetName
    && a.sourceLabel === b.sourceLabel
    && a.latestVersion === b.latestVersion
    && a.openPrUrl === b.openPrUrl
    && a.publishable === b.publishable
  )
}

export function useAgentTemplateStatus(agentSlug: string | null) {
  const queryClient = useQueryClient()

  const query = useQuery<ApiAgentTemplateStatus>({
    queryKey: ['agent-template-status', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug!)}/template-status`)
      if (!res.ok) throw new Error('Failed to fetch template status')
      return await res.json() as ApiAgentTemplateStatus
    },
    enabled: !!agentSlug,
  })

  // Fire a single background refresh per slug, per session — this kicks any
  // pending queue items forward and adopts merged content. We do it in an
  // effect (not inside queryFn) so the read path stays pure and React Query's
  // own retries/refetches don't trigger extra network calls.
  const lastSlugRef = useRef<string | null>(null)
  useEffect(() => {
    if (!agentSlug) return
    if (lastSlugRef.current === agentSlug) return
    lastSlugRef.current = agentSlug

    if (templateRefreshSet.has(agentSlug)) return
    templateRefreshSet.add(agentSlug)

    let cancelled = false
    apiFetch(`/api/agents/${encodeURIComponent(agentSlug)}/template-refresh`, { method: 'POST' })
      .then(async (r) => {
        if (cancelled || !r.ok) return
        const fresh = await r.json() as ApiAgentTemplateStatus
        const current = queryClient.getQueryData<ApiAgentTemplateStatus>(['agent-template-status', agentSlug])
        if (!current || !statusesEqual(fresh, current)) {
          queryClient.setQueryData(['agent-template-status', agentSlug], fresh)
        }
      })
      .catch(() => { /* best-effort; a user-triggered refresh surfaces the error */ })

    return () => { cancelled = true }
  }, [agentSlug, queryClient])

  return query
}

export function useRefreshAgentTemplateStatus() {
  const queryClient = useQueryClient()

  return useMutation<
    ApiAgentTemplateStatus,
    Error,
    { agentSlug: string }
  >({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ agentSlug }) => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug)}/template-refresh`, {
        method: 'POST',
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to refresh template status')
      }
      return res.json()
    },
    onSuccess: (data, vars) => {
      queryClient.setQueryData(['agent-template-status', vars.agentSlug], data)
    },
  })
}

function useTemplateUpdateMutation(errorMessage: string) {
  const queryClient = useQueryClient()

  return useMutation<
    { updated: boolean },
    Error,
    { agentSlug: string }
  >({
    mutationFn: async ({ agentSlug }) => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug)}/template-update`, {
        method: 'POST',
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || errorMessage)
      }
      return res.json()
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['agent-template-status', vars.agentSlug] })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export function useUpdateAgentTemplate() {
  return useTemplateUpdateMutation('Failed to update template')
}

export function useForceSyncAgentTemplate() {
  return useTemplateUpdateMutation('Failed to sync template from remote')
}

export interface AgentTemplatePRInfo {
  agentName: string
  agentPath: string
  skillsetUrl: string
  suggestedTitle: string
  suggestedBody: string
  suggestedVersion: string
}

export function useAgentTemplatePRInfo(agentSlug: string | null) {
  return useQuery<AgentTemplatePRInfo>({
    queryKey: ['agent-template-pr-info', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug!)}/template-pr-info`)
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to get PR info')
      }
      return res.json()
    },
    enabled: !!agentSlug,
  })
}

export function useCreateAgentTemplatePR() {
  const queryClient = useQueryClient()

  return useMutation<
    { prUrl?: string; successMessage: string },
    Error,
    { agentSlug: string; title: string; body: string; newVersion?: string }
  >({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ agentSlug, title, body, newVersion }) => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug)}/template-create-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, newVersion }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to create PR')
      }
      return res.json()
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['agent-template-status', vars.agentSlug] })
    },
  })
}

export interface AgentTemplatePublishInfo {
  agentName: string
  skillsetUrl: string
  skillsetName: string
  suggestedTitle: string
  suggestedBody: string
  suggestedVersion: string
}

export function useAgentTemplatePublishInfo(
  agentSlug: string | null,
  skillsetId: string | null,
) {
  return useQuery<AgentTemplatePublishInfo>({
    queryKey: ['agent-template-publish-info', agentSlug, skillsetId],
    queryFn: async () => {
      const res = await apiFetch(
        `/api/agents/${encodeURIComponent(agentSlug!)}/template-publish-info?skillsetId=${encodeURIComponent(skillsetId!)}`
      )
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to get publish info')
      }
      return res.json()
    },
    enabled: !!agentSlug && !!skillsetId,
  })
}

export function usePublishAgentTemplate() {
  const queryClient = useQueryClient()

  return useMutation<
    { prUrl?: string; successMessage: string },
    Error,
    {
      agentSlug: string
      skillsetId: string
      title: string
      body: string
      newVersion?: string
    }
  >({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ agentSlug, skillsetId, title, body, newVersion }) => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug)}/template-publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillsetId, title, body, newVersion }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to publish template')
      }
      return res.json()
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['agent-template-status', vars.agentSlug] })
      queryClient.invalidateQueries({ queryKey: ['discoverable-agents'] })
    },
  })
}
