import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import type { VolumeDefinitionSummary } from '@shared/lib/types/mount'
import { volumeConfigSchema, type VolumeSource } from '@shared/lib/volumes/volume-config-schema'
import type { MyAgentDrive } from '@shared/lib/services/user-settings-service'

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
  })
}

export function useSaveVolumeDefinition() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (input: VolumeSettingsInput | { id: string; name?: string; visibility?: VolumeSettingsInput['visibility'] }) => {
      const id = 'id' in input ? input.id : undefined
      const body = 'id' in input ? { name: input.name, visibility: input.visibility } : { name: input.name, visibility: input.visibility, ...volumeConfigSchema.parse(input.source) }
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


export function useVolumeAgents(id: string) {
  return useQuery<{ attachments: { agentSlug: string; mountId: string }[] }>({
    queryKey: ['volume-agents', id],
    queryFn: async () => (await checkedResponse(await apiFetch(`/api/volume-definitions/${encodeURIComponent(id)}/agents`))).json(),
  })
}

/** What turning the drive on would reach, from the same rule the server applies. */
export function useMyAgentsPreview(id: string, shared: boolean | null) {
  return useQuery<{ agents: number; sharedAgents: string[] }>({
    queryKey: ['my-agents-preview', id, shared],
    enabled: shared !== null,
    // Consent is given against this list, so never answer from cache or wait out retries.
    staleTime: 0,
    retry: false,
    queryFn: async () => (await checkedResponse(await apiFetch(`/api/volume-definitions/${encodeURIComponent(id)}/my-agents?shared=${shared}`))).json(),
  })
}

/** Turn "Add to all my agents" on with a setting, or off (null). */
export function useSetMyAgentDrive(id: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (setting: MyAgentDrive | null): Promise<{ agents?: number }> => (await checkedResponse(await apiFetch(
      `/api/volume-definitions/${encodeURIComponent(id)}/my-agents`,
      setting ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(setting) } : { method: 'DELETE' },
    ))).json(),
    // The setting is saved before agents are updated, so refresh even when a later step failed.
    onSettled: () => {
      client.invalidateQueries({ queryKey: ['user-settings'] })
      client.invalidateQueries({ queryKey: ['volume-agents', id] })
      client.invalidateQueries({ queryKey: ['volume-definitions'] })
      client.invalidateQueries({ queryKey: ['mounts'] })
      client.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}
