import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  PlatformSkillRegistryEntry,
  PlatformSkillsetIndex,
  PlatformSkillContent,
  PlatformSkillFile,
} from '@shared/lib/services/platform-skills-service'

/**
 * Fetch all skillsets from the connected platform org.
 */
export function usePlatformSkillsets() {
  return useQuery<PlatformSkillRegistryEntry[]>({
    queryKey: ['platform-skillsets'],
    queryFn: async () => {
      const res = await apiFetch('/api/platform-skills/skillsets')
      if (!res.ok) throw new Error('Failed to fetch platform skillsets')
      const data = await res.json()
      return data.skillsets
    },
  })
}

/**
 * Fetch a single platform skillset with its skills and agents lists.
 */
export function usePlatformSkillset(name: string | null) {
  return useQuery<PlatformSkillsetIndex>({
    queryKey: ['platform-skillset', name],
    queryFn: async () => {
      const res = await apiFetch(`/api/platform-skills/skillsets/${encodeURIComponent(name!)}`)
      if (!res.ok) throw new Error('Failed to fetch platform skillset')
      const data = await res.json()
      return data.skillset
    },
    enabled: !!name,
  })
}

/**
 * Fetch content of a specific skill from the platform.
 */
export function usePlatformSkillContent(skillsetName: string | null, skillName: string | null) {
  return useQuery<PlatformSkillContent>({
    queryKey: ['platform-skill-content', skillsetName, skillName],
    queryFn: async () => {
      const res = await apiFetch(
        `/api/platform-skills/skillsets/${encodeURIComponent(skillsetName!)}/skills/${encodeURIComponent(skillName!)}`,
      )
      if (!res.ok) throw new Error('Failed to fetch platform skill content')
      return res.json()
    },
    enabled: !!skillsetName && !!skillName,
  })
}

/**
 * Fetch files for a specific skill from the platform.
 */
export function usePlatformSkillFiles(skillsetName: string | null, skillName: string | null) {
  return useQuery<PlatformSkillFile[]>({
    queryKey: ['platform-skill-files', skillsetName, skillName],
    queryFn: async () => {
      const res = await apiFetch(
        `/api/platform-skills/skillsets/${encodeURIComponent(skillsetName!)}/skills/${encodeURIComponent(skillName!)}/files`,
      )
      if (!res.ok) throw new Error('Failed to fetch platform skill files')
      const data = await res.json()
      return data.files
    },
    enabled: !!skillsetName && !!skillName,
  })
}

/**
 * Fetch all platform skillsets with their skills lists expanded.
 * Returns a flat array of { skillsetName, skill } pairs for unified display.
 */
export function usePlatformDiscoverableSkills() {
  return useQuery<PlatformSkillsetIndex[]>({
    queryKey: ['platform-discoverable-skills'],
    queryFn: async () => {
      const listRes = await apiFetch('/api/platform-skills/skillsets')
      if (!listRes.ok) throw new Error('Failed to fetch platform skillsets')
      const { skillsets } = (await listRes.json()) as { skillsets: PlatformSkillRegistryEntry[] }

      const results = await Promise.all(
        skillsets.map(async (ss) => {
          const res = await apiFetch(
            `/api/platform-skills/skillsets/${encodeURIComponent(ss.name)}`,
          )
          if (!res.ok) return null
          const data = (await res.json()) as { skillset: PlatformSkillsetIndex }
          return data.skillset
        }),
      )
      return results.filter((r): r is PlatformSkillsetIndex => r !== null)
    },
  })
}

/**
 * Install a platform skill into a local agent.
 */
export function useInstallPlatformSkill() {
  const queryClient = useQueryClient()

  return useMutation<
    { installed: boolean; fileCount: number },
    Error,
    { agentSlug: string; skillsetName: string; skillName: string; displayName: string }
  >({
    mutationFn: async ({ agentSlug, skillsetName, skillName, displayName }) => {
      const res = await apiFetch('/api/platform-skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentSlug, skillsetName, skillName, displayName }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to install skill')
      }
      return res.json()
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['agent-skills', variables.agentSlug] })
    },
  })
}

/**
 * Install a platform agent template as a new local agent.
 */
export function useInstallPlatformAgent() {
  const queryClient = useQueryClient()

  return useMutation<
    { agentSlug: string; fileCount: number },
    Error,
    { skillsetName: string; agentName: string; displayName: string }
  >({
    mutationFn: async ({ skillsetName, agentName, displayName }) => {
      const res = await apiFetch('/api/platform-skills/install-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillsetName, agentName, displayName }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to install agent from platform')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['my-agent-roles'] })
    },
  })
}
