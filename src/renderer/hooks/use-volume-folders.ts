import { useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@renderer/lib/api'
import type { VolumeType } from '@shared/lib/types/mount'

/** A source's folder-browse route, answered in that source's own shape. */
export function useVolumeFolders<Folders>(source: { type: VolumeType; label: string; schema: z.ZodType<Folders> }, query: Record<string, string>, enabled: boolean) {
  return useQuery({
    queryKey: [`${source.type}-folders`, query],
    enabled: enabled && !!query.accountId,
    retry: false,
    queryFn: async () => {
      const response = await apiFetch(`/api/volume-definitions/${source.type}/folders?${new URLSearchParams(query)}`)
      if (!response.ok) {
        const error = await response.json().catch(() => null)
        throw new Error(error?.error ?? `Could not load ${source.label} folders`)
      }
      return source.schema.parse(await response.json())
    },
  })
}
