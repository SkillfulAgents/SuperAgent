import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import type { ApiAgent, ApiDiscoverableAgent, ApiAgentTemplateStatus } from '@shared/lib/types/api'

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

      // Trigger browser download
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${agentName || agentSlug}-template.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
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

      // Trigger browser download
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${agentName || agentSlug}-full.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
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

export function useAgentTemplateStatus(agentSlug: string | null) {
  return useQuery<ApiAgentTemplateStatus>({
    queryKey: ['agent-template-status', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug!)}/template-status`)
      if (!res.ok) throw new Error('Failed to fetch template status')
      return res.json()
    },
    enabled: !!agentSlug,
  })
}

export function useUpdateAgentTemplate() {
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
        throw new Error(data.error || 'Failed to update template')
      }
      return res.json()
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['agent-template-status', vars.agentSlug] })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
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
    { prUrl: string },
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
    { prUrl: string },
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
