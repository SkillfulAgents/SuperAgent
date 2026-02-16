import { useEffect } from 'react'
import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiAgent, ApiDiscoverableAgent, ApiAgentTemplateStatus } from '@shared/lib/types/api'

/**
 * Fetch discoverable agents from skillsets.
 * First returns cached data (fast), then triggers a background refresh
 * and re-fetches to pick up any new agents from remote repos.
 */
export function useDiscoverableAgents() {
  const queryClient = useQueryClient()

  const query = useQuery<ApiDiscoverableAgent[]>({
    queryKey: ['discoverable-agents'],
    queryFn: async () => {
      const res = await apiFetch('/api/agents/discoverable-agents')
      if (!res.ok) throw new Error('Failed to fetch discoverable agents')
      const data = await res.json()
      return data.agents
    },
  })

  // After initial cached data loads, trigger a background refresh
  useEffect(() => {
    if (query.data) {
      apiFetch('/api/agents/discoverable-agents?refresh=true')
        .then(async (res) => {
          if (res.ok) {
            const data = await res.json()
            const agents = data.agents as ApiDiscoverableAgent[]
            // Only invalidate if the refresh found different results
            if (JSON.stringify(agents) !== JSON.stringify(query.data)) {
              queryClient.setQueryData(['discoverable-agents'], agents)
            }
          }
        })
        .catch(() => { /* ignore background refresh failures */ })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.dataUpdatedAt])

  return query
}

export function useExportAgentTemplate() {
  return useMutation<void, Error, { agentSlug: string; agentName: string }>({
    mutationFn: async ({ agentSlug, agentName }) => {
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

export function useImportAgentTemplate() {
  const queryClient = useQueryClient()

  return useMutation<ApiAgent & { hasOnboarding?: boolean }, Error, { file: File; nameOverride?: string }>({
    mutationFn: async ({ file, nameOverride }) => {
      const formData = new FormData()
      formData.append('file', file)
      if (nameOverride) {
        formData.append('name', nameOverride)
      }

      const res = await apiFetch('/api/agents/import-template', {
        method: 'POST',
        body: formData,
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to import template')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export function useInstallAgentFromSkillset() {
  const queryClient = useQueryClient()

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
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['discoverable-agents'] })
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
