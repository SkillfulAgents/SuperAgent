import { useMemo } from 'react'
import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiSkillsetConfig } from '@shared/lib/types/api'
import type { SkillsetIndex } from '@shared/lib/types/skillset'

export function useSkillsets() {
  return useQuery<ApiSkillsetConfig[]>({
    queryKey: ['skillsets'],
    queryFn: async () => {
      const res = await apiFetch('/api/skillsets')
      if (!res.ok) throw new Error('Failed to fetch skillsets')
      return res.json()
    },
  })
}

export function useValidateSkillset() {
  return useMutation<
    { valid: boolean; error?: string; index?: SkillsetIndex },
    Error,
    string
  >({
    mutationFn: async (url: string) => {
      const res = await apiFetch('/api/skillsets/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      return res.json()
    },
  })
}

export function useAddSkillset() {
  const queryClient = useQueryClient()

  return useMutation<ApiSkillsetConfig, Error, string>({
    mutationFn: async (url: string) => {
      const res = await apiFetch('/api/skillsets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to add skillset')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skillsets'] })
    },
  })
}

export function useRemoveSkillset() {
  const queryClient = useQueryClient()

  return useMutation<void, Error, string>({
    mutationFn: async (id: string) => {
      const res = await apiFetch(`/api/skillsets/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to remove skillset')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skillsets'] })
    },
  })
}

/**
 * Look up the publishMode for a skillset by its ID.
 * Falls back to 'pull_request' if the skillset is unknown (e.g. removed).
 */
export function useSkillsetPublishMode(
  skillsetId: string | undefined,
): ApiSkillsetConfig['publishMode'] {
  const { data: skillsets } = useSkillsets()
  return useMemo(
    () => skillsets?.find((s) => s.id === skillsetId)?.publishMode ?? 'pull_request',
    [skillsets, skillsetId],
  )
}

export function useRefreshSkillset() {
  const queryClient = useQueryClient()

  return useMutation<unknown, Error, string>({
    mutationFn: async (id: string) => {
      const res = await apiFetch(`/api/skillsets/${encodeURIComponent(id)}/refresh`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to refresh skillset')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skillsets'] })
      queryClient.invalidateQueries({ queryKey: ['discoverable-skills'] })
      queryClient.invalidateQueries({ queryKey: ['agent-skills'] })
    },
  })
}


