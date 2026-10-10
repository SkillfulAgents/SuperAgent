import { useState } from 'react'
import { ArrowLeft, ChevronRight, Folder, FolderOpen, Loader2 } from 'lucide-react'
import { useDropboxFolders } from '@renderer/hooks/use-dropbox-folders'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import type { DropboxVolumeConfig } from '@shared/lib/volumes/dropbox-schema'

export function DropboxFolderPicker({ accountId, value, onChange, disabled }: {
  accountId: string
  value: DropboxVolumeConfig | null
  onChange: (value: DropboxVolumeConfig) => void
  disabled: boolean
}) {
  const [browsing, setBrowsing] = useState(false)
  const [path, setPath] = useState(value?.path ?? '')
  const folders = useDropboxFolders(accountId, path, browsing)
  return <>
    <div className="space-y-2">
      <p className="text-sm font-medium">Folder</p>
      <Button type="button" variant="outline" className="w-full justify-start" disabled={disabled}
        onClick={() => { setPath(value?.path ?? ''); setBrowsing(true) }}>
        <FolderOpen className="h-4 w-4" />{value ? 'Change folder' : 'Select folder'}
      </Button>
      {value && <p className="break-all text-xs text-muted-foreground" data-testid="selected-volume-folder">{value.path || 'Entire Dropbox'}</p>}
    </div>
    <Dialog open={browsing} onOpenChange={setBrowsing}>
      <DialogContent className="sm:max-w-lg" data-testid="dropbox-folder-picker">
        <DialogHeader>
          <DialogTitle>Select a Dropbox folder</DialogTitle>
          <DialogDescription>Choose a folder, or select the root to mount your entire Dropbox.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1">
          <Button type="button" variant="ghost" size="icon" aria-label="Parent folder" disabled={!path}
            onClick={() => setPath(path.slice(0, path.lastIndexOf('/')))}><ArrowLeft className="h-4 w-4" /></Button>
          <span className="min-w-0 break-all text-sm">{path || 'Dropbox'}</span>
        </div>
        <div className="max-h-64 min-h-32 overflow-y-auto rounded-md border p-1">
          {folders.isFetching ? <p role="status" className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading folders…</p>
            : folders.error ? <div className="p-3"><p role="alert" className="text-sm text-destructive">{folders.error.message}</p><Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { void folders.refetch() }}>Try again</Button></div>
            : folders.data?.folders.length ? folders.data.folders.map(folder => <button key={folder.path} type="button" onClick={() => setPath(folder.path)}
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Folder className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{folder.name}</span><ChevronRight className="h-4 w-4" />
            </button>) : <p className="p-3 text-sm text-muted-foreground">No subfolders</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setBrowsing(false)}>Cancel</Button>
          <Button type="button" disabled={!folders.data || folders.isFetching || !!folders.error || disabled}
            onClick={() => { onChange({ accountId, path }); setBrowsing(false) }}>{path ? 'Use this folder' : 'Use Dropbox root'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
