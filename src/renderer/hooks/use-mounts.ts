import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentMount, AgentMountWithHealth } from '@shared/lib/types/mount'

async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    return body.error || fallback
  } catch {
    return fallback
  }
}

export function useAgentMounts(agentSlug: string) {
  return useQuery<AgentMountWithHealth[]>({
    queryKey: ['mounts', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/mounts`)
      if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to fetch mounts'))
      return res.json()
    },
    enabled: !!agentSlug,
  })
}

export function useAddMount() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: { agentSlug: string; hostPath: string; restart?: boolean }) => {
      const res = await apiFetch(`/api/agents/${data.agentSlug}/mounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostPath: data.hostPath, restart: data.restart }),
      })
      if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to add mount'))
      return res.json() as Promise<AgentMount>
    },
    onSuccess: (_, { agentSlug }) => {
      queryClient.invalidateQueries({ queryKey: ['mounts', agentSlug] })
    },
  })
}

export function useRemoveMount() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: { agentSlug: string; mountId: string; restart?: boolean }) => {
      const url = `/api/agents/${data.agentSlug}/mounts/${data.mountId}${data.restart ? '?restart=true' : ''}`
      const res = await apiFetch(url, { method: 'DELETE' })
      if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to remove mount'))
    },
    onSuccess: (_, { agentSlug }) => {
      queryClient.invalidateQueries({ queryKey: ['mounts', agentSlug] })
    },
  })
}
