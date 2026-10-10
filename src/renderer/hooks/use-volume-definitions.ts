import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import type { VolumeDefinitionSummary } from '@shared/lib/types/mount'
import { volumeConfigSchema, type VolumeSource } from '@shared/lib/volumes/volume-config-schema'

export interface VolumeSettingsInput {
  name: string
  source?: VolumeSource
  visibility: 'public' | 'private'
}

async function checkedResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error ?? 'Could not update volumes')
  }
  return response
}

export function useVolumeDefinitions() {
  return useQuery<VolumeDefinitionSummary[]>({
    queryKey: ['volume-definitions'],
    queryFn: async () => (await checkedResponse(await apiFetch('/api/volume-definitions'))).json(),
  })
}

export function useSaveVolumeDefinition() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (input: VolumeSettingsInput & { id?: string }) => {
      const { id, name, visibility, source } = input
      const body = id ? { name, visibility } : { name, visibility, ...volumeConfigSchema.parse(source) }
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

export function useDeleteVolumeDefinition() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => checkedResponse(await apiFetch(`/api/volume-definitions/${id}`, { method: 'DELETE' })),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['volume-definitions'] })
    },
  })
}
