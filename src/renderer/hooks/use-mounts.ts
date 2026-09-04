import { useEffect, useState } from 'react'
import type { z } from 'zod'
import { apiFetch } from '@renderer/lib/api'
import { canUseHostFeatures } from '@renderer/lib/host-features'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAgent } from './use-agents'
import {
  agentMountSchema,
  agentMountsResponseSchema,
  sharedVolumeListItemSchema,
  sharedVolumeListResponseSchema,
} from '@shared/lib/services/mount-schema'

async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    return body.error || fallback
  } catch {
    return fallback
  }
}

export type SharedVolumeListItem = z.infer<typeof sharedVolumeListItemSchema>
export type AgentMountsResponse = z.infer<typeof agentMountsResponseSchema>

const EMPTY: AgentMountsResponse = { hostFolders: false, sharedVolumes: false, mounts: [] }

export function useAgentMounts(agentSlug: string) {
  return useQuery<AgentMountsResponse>({
    queryKey: ['mounts', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/mounts`)
      if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to fetch mounts'))
      return agentMountsResponseSchema.parse(await res.json())
    },
    enabled: !!agentSlug,
  })
}

/** Every shared volume in the workspace, for the attach-existing list and the row menus. */
export function useSharedVolumeRegistry() {
  return useQuery<SharedVolumeListItem[]>({
    queryKey: ['shared-volumes'],
    queryFn: async () => {
      const res = await apiFetch('/api/volumes')
      if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to fetch shared volumes'))
      return sharedVolumeListResponseSchema.parse(await res.json()).volumes
    },
  })
}

export function useAddMount() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: { agentSlug: string; hostPath: string; restart?: boolean }) => {
      if (!data.hostPath) {
        throw new Error('Could not determine the folder’s location on disk. Try dragging the folder in, or attach it as an upload.')
      }
      const res = await apiFetch(`/api/agents/${data.agentSlug}/mounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostPath: data.hostPath, restart: data.restart }),
      })
      if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to add mount'))
      return agentMountSchema.parse(await res.json())
    },
    onSuccess: () => {
      // Bare prefix (not keyed on agentSlug): the agent-home Volumes card keys on the
      // canonical id, but this mutation can fire from the session composer's
      // display-slug route, so a targeted key would miss it.
      queryClient.invalidateQueries({ queryKey: ['mounts'] })
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
    },
  })
}

export function useVolumesManager(agentSlug: string) {
  const queryClient = useQueryClient()
  const { data, isLoading, refetch } = useAgentMounts(agentSlug)
  const { hostFolders, sharedVolumes, mounts } = data ?? EMPTY
  const { data: registryData, isSuccess: registryReady } = useSharedVolumeRegistry()
  const registry = registryData ?? []
  const { data: agent } = useAgent(agentSlug)
  const isAgentRunning = agent?.status === 'running'
  const addMount = useAddMount()
  const removeMount = useRemoveMount()
  const [pendingRestart, setPendingRestart] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // A stopped agent picks up mount changes on next start — no restart needed.
  useEffect(() => {
    if (!isAgentRunning && pendingRestart) {
      setPendingRestart(false)
      setRestartError(null)
    }
  }, [isAgentRunning, pendingRestart])

  const markRestartIfRunning = () => {
    if (isAgentRunning) setPendingRestart(true)
  }

  // Shared writes change both the agent's list and the workspace registry.
  const invalidateShared = () => {
    void queryClient.invalidateQueries({ queryKey: ['mounts'] })
    void queryClient.invalidateQueries({ queryKey: ['shared-volumes'] })
  }

  const handleAddFolder = async () => {
    const dirPath = await window.electronAPI?.openDirectory()
    if (!dirPath) return
    await addMount.mutateAsync({ agentSlug, hostPath: dirPath })
    markRestartIfRunning()
  }

  const handleRemove = async (mountId: string) => {
    setActionError(null)
    try {
      await removeMount.mutateAsync({ agentSlug, mountId })
      markRestartIfRunning()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to remove mount')
    }
  }

  const sharedWrite = async (url: string, init: RequestInit, fallback: string) => {
    const res = await apiFetch(url, init)
    if (!res.ok) throw new Error(await parseErrorMessage(res, fallback))
    invalidateShared()
    markRestartIfRunning()
  }

  const trackedWrite = async (url: string, init: RequestInit, fallback: string) => {
    setActionError(null)
    try {
      await sharedWrite(url, init, fallback)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : fallback)
      throw error
    }
  }

  const createShared = (name: string) =>
    sharedWrite(`/api/agents/${agentSlug}/volumes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }, 'Failed to create shared volume')
  const attachShared = (volumeId: string) =>
    trackedWrite(`/api/agents/${agentSlug}/volumes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volumeId }) }, 'Failed to attach shared volume')
  const detachShared = (volumeId: string) =>
    trackedWrite(`/api/agents/${agentSlug}/volumes/${volumeId}`, { method: 'DELETE' }, 'Failed to detach shared volume')
  const deleteShared = (volumeId: string) =>
    trackedWrite(`/api/volumes/${volumeId}`, { method: 'DELETE' }, 'Failed to delete shared volume')

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
    hostFolders,
    sharedVolumes,
    registry,
    registryReady,
    isLoading,
    pendingRestart,
    isRestarting,
    restartError,
    actionError,
    isAddingMount: addMount.isPending,
    isRemovingMount: removeMount.isPending,
    // A host folder is a path on the machine that runs the agent, picked with
    // this computer's directory picker. Both the server and the window must be
    // able to do it.
    canAddFolder: hostFolders && canUseHostFeatures(),
    handleAddFolder,
    handleRemove,
    createShared,
    attachShared,
    detachShared,
    deleteShared,
    handleRestart,
  }
}
