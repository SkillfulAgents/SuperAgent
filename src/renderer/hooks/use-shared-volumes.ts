import { useEffect, useState } from 'react'
import { apiFetch } from '@renderer/lib/api'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAgent } from './use-agents'
import { parseErrorMessage } from './use-mounts'

export interface SharedVolumeAgent {
  slug: string
  name: string
}

export interface SharedVolumeListItem {
  id: string
  name: string
  mountName: string
  attachedAgents: SharedVolumeAgent[]
}

interface SharedVolumesResponse {
  supported: boolean
  volumes: SharedVolumeListItem[]
}

async function readSharedVolumes(): Promise<SharedVolumesResponse> {
  const res = await apiFetch('/api/volumes')
  if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to fetch shared volumes'))
  return res.json() as Promise<SharedVolumesResponse>
}

export function useSharedVolumes(agentSlug: string) {
  const queryClient = useQueryClient()
  const { data: registry, isLoading } = useQuery({
    queryKey: ['shared-volumes'],
    queryFn: readSharedVolumes,
  })
  const { data: agent } = useAgent(agentSlug)
  const isAgentRunning = agent?.status === 'running'
  const [pendingRestart, setPendingRestart] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)

  useEffect(() => {
    if (!isAgentRunning && pendingRestart) {
      setPendingRestart(false)
      setRestartError(null)
    }
  }, [isAgentRunning, pendingRestart])

  const supported = registry?.supported ?? false
  const all = registry?.volumes ?? []
  const attached = all.filter((volume) =>
    volume.attachedAgents.some((agentRef) => agentRef.slug === agentSlug),
  )

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['shared-volumes'] })
  }

  const markRestartIfRunning = () => {
    if (isAgentRunning) setPendingRestart(true)
  }

  const create = async (name: string) => {
    const res = await apiFetch(`/api/agents/${agentSlug}/volumes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to create shared volume'))
    invalidate()
    markRestartIfRunning()
  }

  const attach = async (volumeId: string) => {
    const res = await apiFetch(`/api/agents/${agentSlug}/volumes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volumeId }),
    })
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to attach shared volume'))
    invalidate()
    markRestartIfRunning()
  }

  const detach = async (volumeId: string) => {
    const res = await apiFetch(`/api/agents/${agentSlug}/volumes/${volumeId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to detach shared volume'))
    invalidate()
    markRestartIfRunning()
  }

  const remove = async (volumeId: string) => {
    const res = await apiFetch(`/api/volumes/${volumeId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to delete shared volume'))
    invalidate()
    markRestartIfRunning()
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to restart agent'
      console.error('Failed to restart agent:', error)
      setRestartError(message)
    } finally {
      setIsRestarting(false)
    }
  }

  return {
    supported,
    attached,
    all,
    isLoading,
    create,
    attach,
    detach,
    remove,
    pendingRestart,
    handleRestart,
    isRestarting,
    restartError,
    isAgentRunning,
  }
}
