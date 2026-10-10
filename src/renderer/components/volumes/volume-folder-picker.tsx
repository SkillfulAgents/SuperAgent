import { useState } from 'react'
import { ArrowLeft, ChevronRight, Folder, FolderOpen, Loader2 } from 'lucide-react'
import type { z } from 'zod'
import { useVolumeFolders } from '@renderer/hooks/use-volume-folders'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import type { VolumeType } from '@shared/lib/types/mount'

/** How a remote source browses: a cursor names where the picker is, and the
 * source turns it into a route query and the listed folders into child cursors. */
export interface VolumeFolderSource<Cursor, Folders> {
  type: VolumeType
  label: string
  schema: z.ZodType<Folders>
  title: string
  description: string
  query(accountId: string, cursor: Cursor): Record<string, string>
  folders(data: Folders, cursor: Cursor): { id: string; name: string; cursor: Cursor }[]
  location(cursor: Cursor): string
  /** The cursor one level up, or null at the top. */
  parent(cursor: Cursor): Cursor | null
  /** The confirm button's label, or null where nothing can be selected. */
  selectLabel(cursor: Cursor): string | null
}

export function VolumeFolderPicker<Cursor, Folders>({ source, accountId, initial, selected, onChange, disabled }: {
  source: VolumeFolderSource<Cursor, Folders>
  accountId: string
  initial: Cursor
  /** What the chosen folder is called, or null before one is chosen. */
  selected: string | null
  onChange: (cursor: Cursor) => void
  disabled: boolean
}) {
  const [browsing, setBrowsing] = useState(false)
  const [chosen, setChosen] = useState(initial)
  const [cursor, setCursor] = useState(initial)
  const folders = useVolumeFolders(source, source.query(accountId, cursor), browsing)
  const parent = source.parent(cursor)
  const selectLabel = source.selectLabel(cursor)
  return <>
    <div className="space-y-2">
      <p className="text-sm font-medium">Folder</p>
      <Button type="button" variant="outline" className="w-full justify-start" disabled={disabled}
        onClick={() => { setCursor(chosen); setBrowsing(true) }}>
        <FolderOpen className="h-4 w-4" />{selected !== null ? 'Change folder' : 'Select folder'}
      </Button>
      {selected !== null && <p className="break-all text-xs text-muted-foreground" data-testid="selected-volume-folder">{selected}</p>}
    </div>
    <Dialog open={browsing} onOpenChange={setBrowsing}>
      <DialogContent className="sm:max-w-lg" data-testid={`${source.type}-folder-picker`}>
        <DialogHeader>
          <DialogTitle>{source.title}</DialogTitle>
          <DialogDescription>{source.description}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1">
          <Button type="button" variant="ghost" size="icon" aria-label="Parent folder" disabled={parent === null}
            onClick={() => { if (parent !== null) setCursor(parent) }}><ArrowLeft className="h-4 w-4" /></Button>
          <span className="min-w-0 break-all text-sm">{source.location(cursor)}</span>
        </div>
        <div className="max-h-64 min-h-32 overflow-y-auto rounded-md border p-1">
          {folders.isFetching ? <p role="status" className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading folders…</p>
            : folders.error ? <div className="p-3"><p role="alert" className="text-sm text-destructive">{folders.error.message}</p><Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { void folders.refetch() }}>Try again</Button></div>
            : folders.data && source.folders(folders.data, cursor).length ? source.folders(folders.data, cursor).map(folder => <button key={folder.id} type="button" onClick={() => setCursor(folder.cursor)}
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Folder className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{folder.name}</span><ChevronRight className="h-4 w-4" />
            </button>) : <p className="p-3 text-sm text-muted-foreground">No subfolders</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setBrowsing(false)}>Cancel</Button>
          <Button type="button" disabled={!folders.data || folders.isFetching || !!folders.error || disabled || selectLabel === null}
            onClick={() => { setChosen(cursor); onChange(cursor); setBrowsing(false) }}>{selectLabel ?? 'Use this folder'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
