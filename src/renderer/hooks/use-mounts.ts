import { useState } from 'react'
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

export function useVolumesManager(agentSlug: string) {
  const { data: mountsData, isLoading, refetch } = useAgentMounts(agentSlug)
  const mounts = Array.isArray(mountsData) ? mountsData : []
  const addMount = useAddMount()
  const removeMount = useRemoveMount()
  const [pendingRestart, setPendingRestart] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)

  const handleAddMount = async () => {
    const dirPath = await window.electronAPI?.openDirectory()
    if (!dirPath) return
    await addMount.mutateAsync({ agentSlug, hostPath: dirPath })
    setPendingRestart(true)
  }

  const handleRemove = async (mountId: string) => {
    try {
      await removeMount.mutateAsync({ agentSlug, mountId })
      setPendingRestart(true)
    } catch (error) {
      console.error('Failed to remove mount:', error)
    }
  }

  const handleRestart = async () => {
    setIsRestarting(true)
    try {
      await apiFetch(`/api/agents/${agentSlug}/stop`, { method: 'POST' })
      await apiFetch(`/api/agents/${agentSlug}/start`, { method: 'POST' })
      setPendingRestart(false)
      refetch()
    } catch (error) {
      console.error('Failed to restart agent:', error)
    } finally {
      setIsRestarting(false)
    }
  }

  return {
    mounts,
    isLoading,
    pendingRestart,
    isRestarting,
    isAddingMount: addMount.isPending,
    isRemovingMount: removeMount.isPending,
    handleAddMount,
    handleRemove,
    handleRestart,
  }
}
