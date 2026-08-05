import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'

export interface FolderEntry {
  name: string
  path: string
  type: 'file' | 'directory'
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
