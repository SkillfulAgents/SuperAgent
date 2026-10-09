import { useEffect, useState } from 'react'
import { canUseHostFeatures } from '@renderer/lib/host-features'
import { apiFetch } from '@renderer/lib/api'
import { fetchWithVolumeStopConfirmation } from '@renderer/lib/volume-stop'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAgent } from './use-agents'
import { useVolumeDefinitions, type VolumeSettingsInput } from './use-volume-definitions'
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
    mutationFn: async (data: { agentSlug: string; restart?: boolean } & ({ hostPath: string; volumeId?: never; name?: string; visibility?: 'public' | 'private' } | { volumeId: string; hostPath?: never; name?: never; visibility?: never })) => {
      if (!data.volumeId && !data.hostPath) {
        throw new Error('Could not determine the folder’s location on disk. Try dragging the folder in, or attach it as an upload.')
      }
      const res = await fetchWithVolumeStopConfirmation(`/api/agents/${data.agentSlug}/mounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data.volumeId
          ? { volumeId: data.volumeId, restart: data.restart }
          : { type: 'local', config: { path: data.hostPath }, name: data.name, visibility: data.visibility, restart: data.restart }),
      }, 'Restart')
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
      const res = await fetchWithVolumeStopConfirmation(url, { method: 'DELETE' }, 'Remove volume')
      if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to remove mount'))
    },
    onSuccess: () => {
      // Bare prefix — see useAddMount: reaches the id-keyed home Volumes card too.
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['mounts'] })
      queryClient.invalidateQueries({ queryKey: ['volume-definitions'] })
    },
  })
}

export function useVolumesManager(agentSlug: string) {
  const { data: mountsData, isLoading, refetch } = useAgentMounts(agentSlug)
  const attachments = Array.isArray(mountsData) ? mountsData : []
  const mounts = attachments.filter(mount => !mount.pendingRemoval)
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

  const handleCreateMount = async ({ name, path, visibility }: VolumeSettingsInput) => {
    if (!canModifyMounts) throw new Error('You do not have permission to add volumes to this agent')
    if (!canCreateMount) throw new Error('Select a folder in the desktop app')
    if (!path) throw new Error('Select a folder')
    setOperationError(null)
    // Create + attach through one atomic API operation. Let the dialog surface
    // errors and retain the form so retrying cannot leave an unused definition.
    await addMount.mutateAsync({ agentSlug, hostPath: path, name, visibility })
    if (isAgentRunning) setPendingRestart(true)
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
      const stopRes = await fetchWithVolumeStopConfirmation(`/api/agents/${agentSlug}/stop`, { method: 'POST' }, 'Restart')
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
    pendingRestart: isAgentRunning && (pendingRestart || attachments.some(mount => mount.pendingRemoval)),
    isRestarting,
    restartError,
    isAddingMount: addMount.isPending,
    isRemovingMount: removeMount.isPending,
    // New local folders use the existing OS picker; saved volumes can be reused from any target.
    canAddMount: canModifyMounts && (canCreateMount || definitions.some(v => !mounts.some(m => m.volumeId === v.id))),
    handleCreateMount,
    handleAttach,
    handleRemove,
    handleRestart,
  }
}
