import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import type { GlobalAccess, VolumeDefinitionSummary } from '@shared/lib/types/mount'
import { localVolumeConfigSchema, volumeConfigSchema, type LocalVolumeConfig, type VolumeSource } from '@shared/lib/volumes/volume-config-schema'

export interface VolumeSettingsInput {
  name: string
  source?: VolumeSource
  visibility: 'public' | 'private'
}

async function checkedResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error ?? 'Could not update drives')
  }
  return response
}

export function useVolumeDefinitions() {
  return useQuery<VolumeDefinitionSummary[]>({
    queryKey: ['volume-definitions'],
    queryFn: async () => (await checkedResponse(await apiFetch('/api/volume-definitions'))).json(),
    refetchInterval: query => query.state.status !== 'error' && query.state.data?.some(volume => volume.health === 'preparing') ? 2000 : false,
  })
}

export function useSaveVolumeDefinition() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (input: VolumeSettingsInput | { id: string; name?: string; visibility?: VolumeSettingsInput['visibility']; global?: GlobalAccess | null }) => {
      const id = 'id' in input ? input.id : undefined
      const body = 'id' in input ? { name: input.name, visibility: input.visibility, global: input.global } : { name: input.name, visibility: input.visibility, ...volumeConfigSchema.parse(input.source) }
      return (await checkedResponse(await apiFetch(`/api/volume-definitions${id ? `/${id}` : ''}`, {
        method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }))).json()
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['volume-definitions'] })
      client.invalidateQueries({ queryKey: ['mounts'] })
    },
  })
}

/** A local drive's folder chosen again in the open panel: the same drive, with a new bookmark. */
export function useReconnectLocalVolume() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, config }: { id: string; config: LocalVolumeConfig }) => (await checkedResponse(await apiFetch(`/api/volume-definitions/${encodeURIComponent(id)}/reconnect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(localVolumeConfigSchema.parse(config)),
    }))).json(),
    onSuccess: (_result, { id }) => {
      client.invalidateQueries({ queryKey: ['volume-definitions'] })
      client.invalidateQueries({ queryKey: ['mounts'] })
      client.invalidateQueries({ queryKey: ['volume-files', id] })
      // The host marks running agents with the drive stale, which their restart prompt reads.
      client.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export function useDeleteVolumeDefinition() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => checkedResponse(await apiFetch(`/api/volume-definitions/${id}`, { method: 'DELETE' })),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['volume-definitions'] })
    },
  })
}


export function useVolumeAgents(id: string) {
  return useQuery<{ attachments: { agentSlug: string; mountId: string }[] }>({
    queryKey: ['volume-agents', id],
    queryFn: async () => (await checkedResponse(await apiFetch(`/api/volume-definitions/${encodeURIComponent(id)}/agents`))).json(),
  })
}
