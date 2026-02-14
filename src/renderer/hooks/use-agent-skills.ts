import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiSkillWithStatus, ApiDiscoverableSkill } from '@shared/lib/types/api'

export function useAgentSkills(agentSlug: string | null) {
  return useQuery<ApiSkillWithStatus[]>({
    queryKey: ['agent-skills', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug!)}/skills`)
      if (!res.ok) throw new Error('Failed to fetch skills')
      const data = await res.json()
      return data.skills
    },
    enabled: !!agentSlug,
  })
}

export function useDiscoverableSkills(agentSlug: string | null) {
  return useQuery<ApiDiscoverableSkill[]>({
    queryKey: ['discoverable-skills', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug!)}/discoverable-skills`)
      if (!res.ok) throw new Error('Failed to fetch discoverable skills')
      const data = await res.json()
      return data.skills
    },
    enabled: !!agentSlug,
  })
}

export function useInstallSkill() {
  const queryClient = useQueryClient()

  return useMutation<
    { installed: boolean; requiredEnvVars?: Array<{ name: string; description: string }> },
    Error,
    {
      agentSlug: string
      skillsetId: string
      skillPath: string
      skillName: string
      skillVersion: string
      envVars?: Record<string, string>
    }
  >({
    mutationFn: async ({ agentSlug, skillsetId, skillPath, skillName, skillVersion, envVars }) => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug)}/skills/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillsetId, skillPath, skillName, skillVersion, envVars }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to install skill')
      }
      return res.json()
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['agent-skills', vars.agentSlug] })
      queryClient.invalidateQueries({ queryKey: ['discoverable-skills', vars.agentSlug] })
    },
  })
}

export function useUpdateSkill() {
  const queryClient = useQueryClient()

  return useMutation<
    { updated: boolean },
    Error,
    { agentSlug: string; skillDir: string }
  >({
    mutationFn: async ({ agentSlug, skillDir }) => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug)}/skills/${encodeURIComponent(skillDir)}/update`, {
        method: 'POST',
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to update skill')
      }
      return res.json()
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['agent-skills', vars.agentSlug] })
    },
  })
}

export interface SkillPRInfo {
  skillName: string
  skillPath: string
  skillsetUrl: string
  suggestedTitle: string
  suggestedBody: string
  suggestedVersion: string
}

export function useSkillPRInfo(agentSlug: string | null, skillDir: string | null) {
  return useQuery<SkillPRInfo>({
    queryKey: ['skill-pr-info', agentSlug, skillDir],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug!)}/skills/${encodeURIComponent(skillDir!)}/pr-info`)
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to get PR info')
      }
      return res.json()
    },
    enabled: !!agentSlug && !!skillDir,
  })
}

export function useCreateSkillPR() {
  const queryClient = useQueryClient()

  return useMutation<
    { prUrl: string },
    Error,
    { agentSlug: string; skillDir: string; title: string; body: string; newVersion?: string }
  >({
    mutationFn: async ({ agentSlug, skillDir, title, body, newVersion }) => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug)}/skills/${encodeURIComponent(skillDir)}/create-pr`, {
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
      queryClient.invalidateQueries({ queryKey: ['agent-skills', vars.agentSlug] })
    },
  })
}

export interface SkillPublishInfo {
  skillName: string
  skillsetUrl: string
  skillsetName: string
  suggestedTitle: string
  suggestedBody: string
  suggestedVersion: string
}

export function useSkillPublishInfo(
  agentSlug: string | null,
  skillDir: string | null,
  skillsetId: string | null,
) {
  return useQuery<SkillPublishInfo>({
    queryKey: ['skill-publish-info', agentSlug, skillDir, skillsetId],
    queryFn: async () => {
      const res = await apiFetch(
        `/api/agents/${encodeURIComponent(agentSlug!)}/skills/${encodeURIComponent(skillDir!)}/publish-info?skillsetId=${encodeURIComponent(skillsetId!)}`
      )
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to get publish info')
      }
      return res.json()
    },
    enabled: !!agentSlug && !!skillDir && !!skillsetId,
  })
}

export function usePublishSkill() {
  const queryClient = useQueryClient()

  return useMutation<
    { prUrl: string },
    Error,
    {
      agentSlug: string
      skillDir: string
      skillsetId: string
      title: string
      body: string
      newVersion?: string
    }
  >({
    mutationFn: async ({ agentSlug, skillDir, skillsetId, title, body, newVersion }) => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug)}/skills/${encodeURIComponent(skillDir)}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillsetId, title, body, newVersion }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to publish skill')
      }
      return res.json()
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['agent-skills', vars.agentSlug] })
      queryClient.invalidateQueries({ queryKey: ['discoverable-skills', vars.agentSlug] })
    },
  })
}

export function useRefreshAgentSkills() {
  const queryClient = useQueryClient()

  return useMutation<
    { skills: ApiSkillWithStatus[] },
    Error,
    { agentSlug: string }
  >({
    mutationFn: async ({ agentSlug }) => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug)}/skills/refresh`, {
        method: 'POST',
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to refresh skills')
      }
      return res.json()
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['agent-skills', vars.agentSlug] })
      queryClient.invalidateQueries({ queryKey: ['discoverable-skills', vars.agentSlug] })
    },
  })
}
