import { useEffect, useRef } from 'react'
import { apiFetch } from '@renderer/lib/api'
import { downloadBlob } from '@renderer/lib/download'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import type { ApiAgent, ApiDiscoverableAgent, ApiItemStatus } from '@shared/lib/types/api'

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

  return useQuery<ApiDiscoverableAgent[]>({
    queryKey: ['discoverable-agents'],
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

      await downloadBlob(res, `${agentName || agentSlug}-template.zip`)
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

      await downloadBlob(res, `${agentName || agentSlug}-full.zip`)
    },
  })
}

export type ImportProgress = { phase: 'uploading' | 'processing'; percent: number }

const CHUNK_SIZE = 50 * 1024 * 1024 // 50MB — under Cloudflare's 100MB limit

export function useImportAgentTemplate() {
  const queryClient = useQueryClient()
  const { track } = useAnalyticsTracking()

  return useMutation<
    ApiAgent & { hasOnboarding?: boolean; requiredEnvVars?: Array<{ name: string; description: string }> },
    Error,
    { file: File; nameOverride?: string; mode?: 'template' | 'full'; onProgress?: (p: ImportProgress) => void }
  >({
    mutationFn: async ({ file, nameOverride, mode, onProgress }) => {
      if (file.size <= CHUNK_SIZE) {
        // Small file — single request (existing behavior)
        const formData = new FormData()
        formData.append('file', file)
        if (nameOverride) formData.append('name', nameOverride)
        if (mode) formData.append('mode', mode)

        onProgress?.({ phase: 'uploading', percent: 100 })
        const res = await apiFetch('/api/agents/import-template', {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error || 'Failed to import template')
        }
        onProgress?.({ phase: 'processing', percent: 100 })
        return res.json()
      }

      // Large file — chunked upload
      const uploadId = crypto.randomUUID()
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, file.size)
        const chunkBlob = file.slice(start, end)

        const formData = new FormData()
        formData.append('chunk', chunkBlob)
        formData.append('uploadId', uploadId)
        formData.append('chunkIndex', String(i))
        formData.append('totalChunks', String(totalChunks))
        formData.append('mode', mode || 'template')
        if (nameOverride) formData.append('name', nameOverride)

        onProgress?.({ phase: 'uploading', percent: (i / totalChunks) * 100 })

        const res = await apiFetch('/api/agents/import-template', {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error || 'Failed to upload chunk')
        }

        // Last chunk returns the final agent result
        if (i === totalChunks - 1) {
          onProgress?.({ phase: 'processing', percent: 100 })
          return res.json()
        }
      }

      // Should not reach here, but satisfy TypeScript
      throw new Error('Unexpected end of chunked upload')
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
    ApiAgent & { hasOnboarding?: boolean; requiredEnvVars?: Array<{ name: string; description: string }> },
    Error,
    {
      skillsetId: string
      agentPath: string
      agentName: string
      agentVersion: string
    }
  >({
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
