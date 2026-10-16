import { useQuery } from '@tanstack/react-query'
import { volumeFoldersSchema } from '@shared/lib/volumes/volume-folders-schema'
import { apiFetch } from '@renderer/lib/api'
import type { VolumeType } from '@shared/lib/types/mount'

/** All sources browse through the type registry and return the same folder shape. */
export function useVolumeFolders(source: { type: VolumeType; label: string }, query: Record<string, string>, enabled: boolean) {
  return useQuery({
    queryKey: [`${source.type}-folders`, query],
    enabled,
    retry: false,
    queryFn: async () => {
      const response = await apiFetch(`/api/volume-types/${source.type}/folders?${new URLSearchParams(query)}`)
      if (!response.ok) {
        const error = await response.json().catch(() => null)
        throw new Error(error?.error ?? `Could not load ${source.label} folders`)
      }
      return volumeFoldersSchema.parse(await response.json())
    },
  })
}
