import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { z } from 'zod'

export interface FolderEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  /** When it last changed, where the source says. */
  mtimeMs?: number
}

export interface FolderEntriesResponse {
  root: string
  path: string
  entries: FolderEntry[]
  truncated: boolean
}

export class FolderEntriesError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** One folder of a shared drive, as the drive's own file browser lists it. */
export async function fetchVolumeFolder(volumeId: string, path: string): Promise<FolderEntriesResponse> {
  const response = await apiFetch(`/api/volume-definitions/${encodeURIComponent(volumeId)}/folders?${new URLSearchParams({ path })}`)
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    throw new FolderEntriesError(z.object({ error: z.string() }).safeParse(body).data?.error ?? 'Could not load this drive', response.status)
  }
  return response.json()
}

export function useFolderEntries(
  agentSlug: string,
  rootPath: string,
  folderPath: string,
  enabled = true,
) {
  return useQuery<FolderEntriesResponse>({
    queryKey: ['folder-entries', agentSlug, rootPath, folderPath],
    queryFn: async () => {
      const params = new URLSearchParams({ root: rootPath, path: folderPath })
      const res = await apiFetch(
        `/api/agents/${encodeURIComponent(agentSlug)}/folders?${params.toString()}`,
      )
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null
        throw new FolderEntriesError(payload?.error ?? 'Failed to load folder', res.status)
      }
      return res.json()
    },
    enabled,
    staleTime: 5_000,
    retry: false,
  })
}
