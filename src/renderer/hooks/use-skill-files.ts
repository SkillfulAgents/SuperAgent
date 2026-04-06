import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiSkillFileEntry } from '@shared/lib/types/api'

export function useSkillFiles(agentSlug: string | null, skillDir: string | null) {
  return useQuery<ApiSkillFileEntry[]>({
    queryKey: ['skill-files', agentSlug, skillDir],
    queryFn: async () => {
      const res = await apiFetch(
        `/api/agents/${encodeURIComponent(agentSlug!)}/skills/${encodeURIComponent(skillDir!)}/files`
      )
      if (!res.ok) throw new Error('Failed to fetch skill files')
      const data = await res.json()
      return data.files
    },
    enabled: !!agentSlug && !!skillDir,
  })
}

export function useSkillFileContent(
  agentSlug: string | null,
  skillDir: string | null,
  filePath: string | null,
) {
  return useQuery<string>({
    queryKey: ['skill-file-content', agentSlug, skillDir, filePath],
    queryFn: async () => {
      const res = await apiFetch(
        `/api/agents/${encodeURIComponent(agentSlug!)}/skills/${encodeURIComponent(skillDir!)}/files/content?path=${encodeURIComponent(filePath!)}`
      )
      if (!res.ok) throw new Error('Failed to read file')
      const data = await res.json()
      return data.content
    },
    enabled: !!agentSlug && !!skillDir && !!filePath,
  })
}

export function useSaveSkillFile() {
  const queryClient = useQueryClient()

  return useMutation<
    { saved: boolean },
    Error,
    { agentSlug: string; skillDir: string; filePath: string; content: string }
  >({
    mutationFn: async ({ agentSlug, skillDir, filePath, content }) => {
      const res = await apiFetch(
        `/api/agents/${encodeURIComponent(agentSlug)}/skills/${encodeURIComponent(skillDir)}/files/content`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, content }),
        }
      )
      if (!res.ok) throw new Error('Failed to save file')
      return res.json()
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['agent-skills', vars.agentSlug] })
    },
  })
}
