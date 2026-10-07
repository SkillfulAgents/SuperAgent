import { useEffect, useState } from 'react'
import { apiFetch } from '@renderer/lib/api'
import { canUseHostFeatures } from '@renderer/lib/host-features'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAgent } from './use-agents'
import { useVolumeDefinitions } from './use-volume-definitions'
import { useUser } from '@renderer/context/user-context'
import type { VolumeSummary, MountSummaryWithHealth } from '@shared/lib/types/mount'

async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    return body.error || fallback
  } catch {
    return fallback
  }
}

export function useAgentMounts(agentSlug: string) {
  return useQuery<MountSummaryWithHealth[]>({
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
    mutationFn: async (data: { agentSlug: string; restart?: boolean } & ({ hostPath: string; volumeId?: never } | { volumeId: string; hostPath?: never })) => {
      if (!data.volumeId && !data.hostPath) {
        throw new Error('Could not determine the folder’s location on disk. Try dragging the folder in, or attach it as an upload.')
      }
      const res = await apiFetch(`/api/agents/${data.agentSlug}/mounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data.volumeId
          ? { volumeId: data.volumeId, restart: data.restart }
          : { type: 'local', config: { path: data.hostPath }, restart: data.restart }),
      })
      if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to add mount'))
      return res.json() as Promise<VolumeSummary>
    },
    onSuccess: () => {
      // Bare prefix (not keyed on agentSlug): the agent-home Volumes card keys on the
      // canonical id, but this mutation can fire from the session composer's
      // display-slug route, so a targeted key would miss it.
      queryClient.invalidateQueries({ queryKey: ['mounts'] })
      queryClient.invalidateQueries({ queryKey: ['volume-definitions'] })
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
    onSuccess: () => {
      // Bare prefix — see useAddMount: reaches the id-keyed home Volumes card too.
      queryClient.invalidateQueries({ queryKey: ['mounts'] })
      queryClient.invalidateQueries({ queryKey: ['volume-definitions'] })
    },
  })
}

export function useVolumesManager(agentSlug: string) {
  const { data: mountsData, isLoading, refetch } = useAgentMounts(agentSlug)
  const mounts = Array.isArray(mountsData) ? mountsData : []
  const registry = useVolumeDefinitions()
  const definitions = registry.data ?? []
  const { canUseAgent } = useUser()
  const canModifyMounts = canUseAgent(agentSlug)
  const canCreateMount = canModifyMounts && canUseHostFeatures()
  const { data: agent } = useAgent(agentSlug)
  const isAgentRunning = agent?.status === 'running'
  const addMount = useAddMount()
  const removeMount = useRemoveMount()
  const [pendingRestart, setPendingRestart] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)

  // A stopped agent picks up mount changes on next start — no restart needed.
  useEffect(() => {
    if (!isAgentRunning && pendingRestart) {
      setPendingRestart(false)
      setRestartError(null)
    }
  }, [isAgentRunning, pendingRestart])

  const handleAddMount = async () => {
    if (!canCreateMount) return
    try {
      setOperationError(null)
      const dirPath = await window.electronAPI?.openDirectory()
      if (!dirPath) return
      await addMount.mutateAsync({ agentSlug, hostPath: dirPath })
      if (isAgentRunning) setPendingRestart(true)
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Failed to add mount')
    }
  }

  const handleAttach = async (volumeId: string) => {
    if (!canModifyMounts) return
    try {
      setOperationError(null)
      await addMount.mutateAsync({ agentSlug, volumeId })
      if (isAgentRunning) setPendingRestart(true)
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Failed to add mount')
    }
  }

  const handleRemove = async (mountId: string) => {
    if (!canModifyMounts) return
    try {
      setOperationError(null)
      await removeMount.mutateAsync({ agentSlug, mountId })
      if (isAgentRunning) setPendingRestart(true)
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Failed to remove mount')
    }
  }

  const handleRestart = async () => {
    setIsRestarting(true)
    setRestartError(null)
    try {
      const stopRes = await apiFetch(`/api/agents/${agentSlug}/stop`, { method: 'POST' })
      if (!stopRes.ok) throw new Error(await parseErrorMessage(stopRes, 'Failed to stop agent'))
      const startRes = await apiFetch(`/api/agents/${agentSlug}/start`, { method: 'POST' })
      if (!startRes.ok) throw new Error(await parseErrorMessage(startRes, 'Failed to start agent'))
      setPendingRestart(false)
      refetch()
    } catch (error) {
      // Keep the banner up so the user can retry; surface the error to the caller.
      const message = error instanceof Error ? error.message : 'Failed to restart agent'
      console.error('Failed to restart agent:', error)
      setRestartError(message)
    } finally {
      setIsRestarting(false)
    }
  }

  return {
    mounts,
    definitions,
    isLoading: isLoading || registry.isLoading,
    operationError: operationError ?? (registry.error ? 'Could not load saved volumes' : null),
    canModifyMounts,
    canCreateMount,
    pendingRestart,
    isRestarting,
    restartError,
    isAddingMount: addMount.isPending,
    isRemovingMount: removeMount.isPending,
    // Only creating a local source needs this computer's directory picker.
    // Attaching a saved source works against any API target.
    canAddMount: canModifyMounts && (canCreateMount || definitions.some(v => !mounts.some(m => m.volumeId === v.id))),
    handleAddMount,
    handleAttach,
    handleRemove,
    handleRestart,
  }
}
