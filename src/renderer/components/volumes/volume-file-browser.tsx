import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { FileBrowser, type FileSource } from '@renderer/components/file-preview/file-browser'
import { Button } from '@renderer/components/ui/button'
import { FolderEntriesError, type FolderEntriesResponse } from '@renderer/hooks/use-folder-entries'
import { apiFetch } from '@renderer/lib/api'
import { getApiBaseUrl } from '@renderer/lib/env'

/** A separate browser scope prevents tab state leaking between volume definitions. */
export function VolumeFileBrowser({ volumeId }: { volumeId: string }) {
  const client = useQueryClient()
  // Bumped by Refresh: every open file's URL changes, so each renderer reloads.
  const [refreshed, setRefreshed] = useState(0)
  const base = `/api/volume-definitions/${encodeURIComponent(volumeId)}`
  const source: FileSource = {
    useEntries(path, enabled) {
      return useQuery<FolderEntriesResponse>({
        queryKey: ['volume-files', volumeId, path],
        queryFn: async () => {
          const response = await apiFetch(`${base}/folders?${new URLSearchParams({ path })}`)
          if (!response.ok) {
            const body = await response.json().catch(() => null) as { error?: string } | null
            throw new FolderEntriesError(body?.error ?? 'Could not load this drive', response.status)
          }
          return response.json()
        },
        enabled, staleTime: 5_000, retry: false,
      })
    },
    useFile(path, version) {
      if (path === null) return null
      const fileUrl = `${getApiBaseUrl()}${base}/file?${new URLSearchParams({ path, v: `${version}-${refreshed}` })}`
      return { inlineUrl: `${fileUrl}&inline=true`, downloadUrl: fileUrl }
    },
  }

  return <section className="space-y-2 min-w-0" aria-label="Drive files">
    <div className="flex items-center justify-between">
      <h3 className="text-xs font-normal text-muted-foreground">Files</h3>
      <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Refresh files" onClick={() => {
        void client.invalidateQueries({ queryKey: ['volume-files', volumeId] })
        setRefreshed(count => count + 1)
      }}><RefreshCw className="h-3.5 w-3.5" /></Button>
    </div>
    <div className="flex h-[min(44rem,75dvh)] min-h-80 flex-col rounded-xl border bg-background overflow-hidden" data-testid="volume-file-preview">
      <FileBrowser key={volumeId} source={source} />
    </div>
  </section>
}
