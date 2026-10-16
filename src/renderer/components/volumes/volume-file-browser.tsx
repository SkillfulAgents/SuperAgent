import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { DirectoryBrowser } from '@renderer/components/file-preview/directory-browser'
import { TabbedFilePreview } from '@renderer/components/file-preview/tabbed-file-preview'
import { FilePreviewProvider } from '@renderer/context/file-preview-context'
import { Button } from '@renderer/components/ui/button'
import { FolderEntriesError, type FolderEntriesResponse } from '@renderer/hooks/use-folder-entries'
import { getFileBrowserTabKey, nextFileVersion, useFilePreviewTabs, type FileBrowserTab } from '@renderer/hooks/use-file-preview-tabs'
import { apiFetch } from '@renderer/lib/api'
import { getApiBaseUrl } from '@renderer/lib/env'

const directoryTab: FileBrowserTab = { kind: 'folder', rootPath: '', displayName: 'Files', closable: false, expandedPaths: [], query: '' }

/** A separate browser scope prevents tab state leaking between volume definitions. */
export function VolumeFileBrowser({ volumeId }: { volumeId: string }) {
  return <FilePreviewProvider key={volumeId} commentsEnabled={false} sessionId={null}>
    <VolumeFileBrowserContent volumeId={volumeId} />
  </FilePreviewProvider>
}

function VolumeFileBrowserContent({ volumeId }: { volumeId: string }) {
  const client = useQueryClient()
  const { openTabs, setOpenTabs, activeTabIndex, setActiveTabIndex, openTab, closeTab, setPdfPage } = useFilePreviewTabs<FileBrowserTab>(getFileBrowserTabKey, [directoryTab])
  const activeTab = openTabs[activeTabIndex]
  const base = `/api/volume-definitions/${encodeURIComponent(volumeId)}`
  function useEntries(path: string, enabled: boolean) {
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
  }
  const fileUrl = activeTab.kind === 'file'
    ? `${getApiBaseUrl()}${base}/file?${new URLSearchParams({ path: activeTab.filePath, v: String(activeTab.version) })}` : null

  return <section className="space-y-2 min-w-0" aria-label="Drive files">
    <div className="flex items-center justify-between">
      <h3 className="text-xs font-normal text-muted-foreground">Files</h3>
      <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Refresh files" onClick={() => {
        void client.invalidateQueries({ queryKey: ['volume-files', volumeId] })
        const version = nextFileVersion()
        setOpenTabs(current => current.map(tab => tab.kind === 'file' ? { ...tab, version } : tab))
      }}><RefreshCw className="h-3.5 w-3.5" /></Button>
    </div>
    <div className="flex h-[min(44rem,75dvh)] min-h-80 flex-col rounded-xl border bg-background overflow-hidden" data-testid="volume-file-preview">
      <TabbedFilePreview
        tabs={openTabs} getTabKey={getFileBrowserTabKey} activeTabIndex={activeTabIndex}
        onSelectTab={setActiveTabIndex} onCloseTab={closeTab}
        file={activeTab.kind === 'file' && fileUrl ? { path: activeTab.filePath, inlineUrl: `${fileUrl}&inline=true`, downloadUrl: fileUrl } : null}
        onPdfPageChange={page => setPdfPage(getFileBrowserTabKey(activeTab), page)}
        folderContent={activeTab.kind === 'folder' && <DirectoryBrowser
          folder={activeTab} useEntries={useEntries}
          onToggle={path => setOpenTabs(current => current.map(tab => tab.kind === 'folder'
            ? { ...tab, expandedPaths: tab.expandedPaths.includes(path) ? tab.expandedPaths.filter(value => value !== path) : [...tab.expandedPaths, path] } : tab))}
          onQueryChange={query => setOpenTabs(current => current.map(tab => tab.kind === 'folder' ? { ...tab, query } : tab))}
          onOpenFile={entry => {
            setOpenTabs(current => current.map(tab => tab.kind === 'folder' ? { ...tab, selectedPath: entry.path } : tab))
            const version = nextFileVersion()
            openTab({ kind: 'file', filePath: entry.path, displayName: entry.name, version, pdfPage: 1 }, existing => ({ ...existing, version }))
          }}
        />}
      />
    </div>
  </section>
}
