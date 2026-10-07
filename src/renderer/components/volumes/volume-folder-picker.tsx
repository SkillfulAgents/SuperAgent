import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, ChevronRight, Folder, Loader2 } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { folderPickerListingSchema } from '@shared/lib/volumes/folder-picker-schema'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'

interface VolumeFolderPickerProps {
  initialFolder?: string
  onSelect: (folder: string) => void
  onClose: () => void
}

/** Browse the API host, so browser/cloud selection never points at the client's filesystem. */
export function VolumeFolderPicker({ initialFolder, onSelect, onClose }: VolumeFolderPickerProps) {
  const [path, setPath] = useState(initialFolder)
  const listing = useQuery({
    queryKey: ['volume-folders', path],
    queryFn: async ({ signal }) => {
      const response = await apiFetch(`/api/volume-definitions/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`, { signal })
      if (!response.ok) throw new Error('This folder is unavailable or cannot be opened')
      return folderPickerListingSchema.parse(await response.json())
    },
    retry: false,
    staleTime: 0,
  })
  const [showHidden, setShowHidden] = useState(false)
  const folders = listing.data?.folders.filter(folder => showHidden || !folder.name.startsWith('.')) ?? []

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-lg" data-testid="volume-folder-picker">
        <DialogHeader>
          <DialogTitle>Select folder</DialogTitle>
          <DialogDescription>Choose a folder on the computer running this workspace.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setPath(listing.data?.parent ?? undefined)} disabled={!listing.data?.parent}>
              <ArrowUp className="h-4 w-4" />Up
            </Button>
            {(listing.data?.locations ?? [{ name: 'Home', path: undefined }]).map(location => (
              <Button key={location.name} type="button" variant="ghost" size="sm" onClick={() => setPath(location.path)}>{location.name}</Button>
            ))}
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground" data-testid="volume-picker-location">{listing.data?.path ?? path}</p>
          <div className="h-64 overflow-y-auto rounded-md border" aria-busy={listing.isFetching}>
            {listing.isPending ? <p role="status" className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading folders…</p> : listing.isError ? (
              <div className="space-y-3 p-4"><p role="alert" className="text-sm text-destructive">{listing.error.message}</p><Button type="button" variant="outline" size="sm" onClick={() => { void listing.refetch() }}>Try again</Button></div>
            ) : folders.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No folders here</p> : folders.map(folder => (
              <button key={folder.path} type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none" onClick={() => setPath(folder.path)} aria-label={`Open ${folder.name}`}>
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{folder.name}</span><ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} />Show hidden folders</label>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={!listing.data || listing.isFetching || listing.isError} onClick={() => { if (listing.data) onSelect(listing.data.path) }}>Select this folder</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
