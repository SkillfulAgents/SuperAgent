import { useState } from 'react'
import { canUseHostFeatures } from '@renderer/lib/capabilities'
import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAgent } from './use-agents'
import { useVolumeDefinitions, type VolumeSettingsInput } from './use-volume-definitions'
import { useUser } from '@renderer/context/user-context'
import { volumeConfigSchema, type VolumeSource } from '@shared/lib/volumes/volume-config-schema'
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
      if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to fetch drives'))
      return res.json()
    },
    enabled: !!agentSlug,
  })
}

export function useAddMount() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: { agentSlug: string; restart?: boolean; name?: string; visibility?: 'public' | 'private' } & (
      { hostPath: string; volumeId?: never; type?: never; config?: never }
      | { volumeId: string; hostPath?: never; type?: never; config?: never }
      | (VolumeSource & { volumeId?: never; hostPath?: never })
    )) => {
      if (!data.volumeId && !data.type && !data.hostPath) {
        throw new Error('Could not determine the folder’s location on disk. Try dragging the folder in, or attach it as an upload.')
      }
      const res = await apiFetch(`/api/agents/${data.agentSlug}/mounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data.volumeId
          ? { volumeId: data.volumeId, restart: data.restart }
          : { ...volumeConfigSchema.parse(data.type ? { type: data.type, config: data.config } : { type: 'local', config: { path: data.hostPath } }), name: data.name, visibility: data.visibility, restart: data.restart }),
      })
      if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to add drive'))
      // The route adds the attached definition's id and name to the mount's summary.
      return res.json() as Promise<VolumeSummary & { volumeId: string; volumeName: string }>
    },
    onSuccess: () => {
      // Bare prefix (not keyed on agentSlug): the agent-home Volumes card keys on the
      // canonical id, but this mutation can fire from the session composer's
      // display-slug route, so a targeted key would miss it.
      queryClient.invalidateQueries({ queryKey: ['mounts'] })
      queryClient.invalidateQueries({ queryKey: ['volume-definitions'] })
      queryClient.invalidateQueries({ queryKey: ['volume-agents'] })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export function useRemoveMount() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: { agentSlug: string; mountId: string; restart?: boolean }) => {
      const url = `/api/agents/${data.agentSlug}/mounts/${data.mountId}${data.restart ? '?restart=true' : ''}`
      const res = await apiFetch(url, { method: 'DELETE' })
      if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to remove drive'))
    },
    onSuccess: () => {
      // Bare prefix — see useAddMount: reaches the id-keyed home Volumes card too.
      queryClient.invalidateQueries({ queryKey: ['mounts'] })
      queryClient.invalidateQueries({ queryKey: ['volume-definitions'] })
      queryClient.invalidateQueries({ queryKey: ['volume-agents'] })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export function useSetMountReadOnly() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: { agentSlug: string; mountId: string; readOnly: boolean }) => {
      const res = await apiFetch(`/api/agents/${data.agentSlug}/mounts/${data.mountId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readOnly: data.readOnly }),
      })
      if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to update drive'))
    },
    onSuccess: () => {
      // Bare prefix - see useAddMount.
      queryClient.invalidateQueries({ queryKey: ['mounts'] })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
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
  const canCreateMount = canModifyMounts
  const { data: agent } = useAgent(agentSlug)
  const isAgentRunning = agent?.status === 'running'
  const addMount = useAddMount()
  const removeMount = useRemoveMount()
  const setMountReadOnly = useSetMountReadOnly()
  const [isRestarting, setIsRestarting] = useState(false)
  const [operationError, setOperationError] = useState<string | null>(null)

  // The host marks a running agent stale on a drive change, and a stop clears it.
  const pendingRestart = isAgentRunning && agent?.stale === true

  const handleCreateMount = async ({ name, source, visibility }: VolumeSettingsInput) => {
    if (!canModifyMounts) throw new Error('You do not have permission to add drives to this agent')
    const validatedSource = volumeConfigSchema.parse(source)
    if (validatedSource.type === 'local' && !canUseHostFeatures()) throw new Error('Select a folder in the desktop app')
    setOperationError(null)
    // Create + attach through one atomic API operation. Let the dialog surface
    // errors and retain the form so retrying cannot leave an unused definition.
    await addMount.mutateAsync({ agentSlug, ...validatedSource, name, visibility })
  }

  const handleAttach = async (volumeId: string) => {
    if (!canModifyMounts) return
    try {
      setOperationError(null)
      await addMount.mutateAsync({ agentSlug, volumeId })
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Failed to add drive')
    }
  }

  const handleRemove = async (mountId: string) => {
    if (!canModifyMounts) return
    try {
      setOperationError(null)
      await removeMount.mutateAsync({ agentSlug, mountId })
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Failed to remove drive')
    }
  }

  const handleSetReadOnly = async (mountId: string, readOnly: boolean) => {
    if (!canModifyMounts) return
    try {
      setOperationError(null)
      await setMountReadOnly.mutateAsync({ agentSlug, mountId, readOnly })
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Failed to update drive')
    }
  }

  const handleRestart = async () => {
    setIsRestarting(true)
    setOperationError(null)
    try {
      const stopRes = await apiFetch(`/api/agents/${agentSlug}/stop`, { method: 'POST' })
      if (!stopRes.ok) throw new Error(await parseErrorMessage(stopRes, 'Failed to stop agent'))
      const startRes = await apiFetch(`/api/agents/${agentSlug}/start`, { method: 'POST' })
      if (!startRes.ok) throw new Error(await parseErrorMessage(startRes, 'Failed to start agent'))
      refetch()
    } catch (error) {
      // Shown outside the prompt: a stop that went through has already hidden it.
      const message = error instanceof Error ? error.message : 'Failed to restart agent'
      console.error('Failed to restart agent:', error)
      setOperationError(message)
    } finally {
      setIsRestarting(false)
    }
  }

  return {
    mounts,
    definitions,
    isLoading: isLoading || registry.isLoading,
    operationError: operationError ?? (registry.error ? 'Could not load saved drives' : null),
    canModifyMounts,
    canCreateMount,
    pendingRestart,
    isRestarting,
    isAddingMount: addMount.isPending,
    isRemovingMount: removeMount.isPending,
    isUpdatingMount: setMountReadOnly.isPending,
    // Dropbox creation and saved volumes work on every target. Local folders keep the OS picker.
    canAddMount: canModifyMounts,
    handleCreateMount,
    handleAttach,
    handleRemove,
    handleSetReadOnly,
    handleRestart,
  }
}
