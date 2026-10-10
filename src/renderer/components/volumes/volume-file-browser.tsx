import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDownToLine, RefreshCw, X } from 'lucide-react'
import { DirectoryBrowser } from '@renderer/components/file-preview/directory-browser'
import { FileRenderer } from '@renderer/components/file-preview/renderers/file-renderer'
import { FilePreviewProvider } from '@renderer/context/file-preview-context'
import { Button } from '@renderer/components/ui/button'
import { FolderEntriesError, type FolderEntriesResponse, type FolderEntry } from '@renderer/hooks/use-folder-entries'
import { apiFetch } from '@renderer/lib/api'
import { getApiBaseUrl } from '@renderer/lib/env'

export function VolumeFileBrowser({ volumeId }: { volumeId: string }) {
  const client = useQueryClient()
  const [expandedPaths, setExpandedPaths] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<FolderEntry | null>(null)
  const [version, setVersion] = useState(0)
  const [pdfPage, setPdfPage] = useState(1)
  const base = `/api/volume-definitions/${encodeURIComponent(volumeId)}`
  function useEntries(path: string, enabled: boolean) {
    return useQuery<FolderEntriesResponse>({
      queryKey: ['volume-files', volumeId, path],
      queryFn: async () => {
        const response = await apiFetch(`${base}/folders?${new URLSearchParams({ path })}`)
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null
          throw new FolderEntriesError(body?.error ?? 'Could not load this volume', response.status)
        }
        return response.json()
      },
      enabled, staleTime: 5_000, retry: false,
    })
  }
  const fileUrl = selected ? `${getApiBaseUrl()}${base}/file?${new URLSearchParams({ path: selected.path, v: String(version) })}` : null
  return <section className="space-y-2 min-w-0" aria-label="Volume files">
    <div className="flex items-center justify-between">
      <h3 className="text-xs font-normal text-muted-foreground">Files</h3>
      <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Refresh files" onClick={() => {
        void client.invalidateQueries({ queryKey: ['volume-files', volumeId] }); setVersion(Date.now())
      }}><RefreshCw className="h-3.5 w-3.5" /></Button>
    </div>
    <div className="rounded-xl border bg-background overflow-hidden">
      <div className={selected ? 'h-56' : 'h-80'}>
        <DirectoryBrowser folder={{ rootPath: '', expandedPaths, query, selectedPath: selected?.path }} useEntries={useEntries}
          onToggle={path => setExpandedPaths(current => current.includes(path) ? current.filter(value => value !== path) : [...current, path])}
          onQueryChange={setQuery} onOpenFile={entry => { setSelected(entry); setVersion(Date.now()); setPdfPage(1) }} />
      </div>
      {selected && fileUrl && <div className="border-t" data-testid="volume-file-preview">
        <div className="flex items-center gap-2 px-4 py-3">
          <h4 className="min-w-0 flex-1 truncate text-sm font-medium">{selected.name}</h4>
          <a href={fileUrl} target="_blank" rel="noopener noreferrer" aria-label="Download file" className="rounded p-1 hover:bg-muted"><ArrowDownToLine className="h-4 w-4" /></a>
          <Button size="icon" variant="ghost" className="h-6 w-6" aria-label="Close file preview" onClick={() => setSelected(null)}><X className="h-4 w-4" /></Button>
        </div>
        <div className="h-[28rem] overflow-auto">
          <FilePreviewProvider commentsEnabled={false} sessionId={null}>
            <FileRenderer key={`${selected.path}:${version}`} filePath={selected.path} fileUrl={`${fileUrl}&inline=true`}
              downloadUrl={fileUrl} pdfPage={pdfPage} onPdfPageChange={setPdfPage} />
          </FilePreviewProvider>
        </div>
      </div>}
    </div>
  </section>
}
