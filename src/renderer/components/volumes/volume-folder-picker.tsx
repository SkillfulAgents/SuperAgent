import { useEffect, useId, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight, Folder, FolderOpen, Loader2, Search } from 'lucide-react'
import type { VolumeFolders } from '@shared/lib/volumes/volume-folders-schema'
import { useVolumeFolders } from '@renderer/hooks/use-volume-folders'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import type { VolumeType } from '@shared/lib/types/mount'

/** How a remote source browses: a cursor names where the picker is, and the
 * source turns it into a route query and the listed folders into child cursors. */
export interface VolumeFolderSource<Cursor> {
  type: VolumeType
  label: string
  title: string
  description: string
  query(accountId: string, cursor: Cursor): Record<string, string>
  folders(data: VolumeFolders, cursor: Cursor): { id: string; name: string; cursor: Cursor }[]
  /** The way down to `cursor` from the top, each step's name and cursor, for the breadcrumb. */
  crumbs(cursor: Cursor): { name: string; cursor: Cursor }[]
  /** The confirm button's label for the folder at `cursor`, or null where it can't be chosen. */
  confirmLabel(cursor: Cursor): string | null
  /** Before anything is chosen, open inside the top level's first folder (Google Drive's My Drive) rather than at the top. */
  opensInFirst?: boolean
}

/**
 * A drive set-up's folder field: one button that reads as the location chosen
 * (or "Select folder" before one is), with a chevron to say it opens a picker.
 * The field's label and its value together name it.
 */
export function FolderLocationField({ location, onClick, disabled }: { location: string | null; onClick: () => void; disabled: boolean }) {
  const id = useId()
  return <div className="space-y-2">
    <p id={`${id}-label`} className="text-sm font-medium">Select folder location</p>
    <Button type="button" variant="outline" className="h-auto min-h-10 w-full justify-start gap-2 py-2 text-left font-normal" disabled={disabled}
      aria-labelledby={`${id}-label ${id}-value`} title={location ?? undefined} onClick={onClick}>
      <FolderOpen className="h-4 w-4 shrink-0" />
      <span id={`${id}-value`} className={cn('min-w-0 flex-1 truncate', location === null && 'text-muted-foreground')}
        data-testid={location !== null ? 'selected-volume-folder' : undefined}>{location ?? 'Select folder'}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </Button>
  </div>
}

/**
 * The folder field of a remote drive's set-up and the browser it opens. A
 * click on a folder selects it and › (or a double-click) opens it; with none
 * selected, the confirm button takes the folder you are in. Either way the
 * button names the folder it will use. A folder the source can't use (a GitHub
 * repository before its branch) can only be opened.
 */
export function VolumeFolderPicker<Cursor>({ source, accountId, initial, selected, onChange, disabled }: {
  source: VolumeFolderSource<Cursor>
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
  const [highlighted, setHighlighted] = useState<{ id: string; name: string; cursor: Cursor } | null>(null)
  const [filter, setFilter] = useState('')
  const folders = useVolumeFolders(source, source.query(accountId, cursor), browsing)
  const crumbs = source.crumbs(cursor)
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2].cursor : null
  const listed = folders.data ? source.folders(folders.data, cursor) : []
  const query = filter.trim().toLocaleLowerCase()
  const shown = listed.filter(folder => folder.name.toLocaleLowerCase().includes(query))

  // Opening inside the first folder happens once per opening of the picker, so stepping back up to the top stays there.
  const entered = useRef(false)
  const entering = browsing && !!source.opensInFirst && !entered.current && selected === null && crumbs.length === 1 && !folders.error
  useEffect(() => {
    if (!entering || !folders.data || folders.isFetching) return
    entered.current = true
    const first = source.folders(folders.data, cursor)[0]
    if (first) { setCursor(first.cursor); setFilter('') }
  }, [entering, folders.data, folders.isFetching, source, cursor])

  const open = (to: Cursor) => { setCursor(to); setHighlighted(null); setFilter('') }
  // Use only acts on a highlighted row that is on screen, whether typing or a refreshed listing hid it.
  const visible = shown.find(folder => folder.id === highlighted?.id) ?? null
  const choice = visible && source.confirmLabel(visible.cursor) !== null ? visible : null
  const target = choice ? choice.cursor : source.confirmLabel(cursor) !== null ? cursor : null
  const confirmLabel = choice ? `Use “${choice.name}”` : source.confirmLabel(cursor)
  const loading = folders.isFetching || entering

  return <>
    <FolderLocationField location={selected} disabled={disabled} onClick={() => { entered.current = false; open(chosen); setBrowsing(true) }} />
    <Dialog open={browsing} onOpenChange={setBrowsing}>
      <DialogContent className="sm:max-w-lg" data-testid={`${source.type}-folder-picker`}>
        <DialogHeader>
          <DialogTitle>{source.title}</DialogTitle>
          <DialogDescription>{source.description}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 items-center gap-1 rounded-md bg-muted px-1 py-1">
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label="Parent folder" disabled={parent === null || loading}
            onClick={() => { if (parent !== null) open(parent) }}><ArrowLeft className="h-4 w-4" /></Button>
          <nav aria-label="Folder path" className="min-w-0 flex-1">
            <ol className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm">
              {crumbs.map((crumb, index) => {
                const here = index === crumbs.length - 1
                return <li key={index} className="flex min-w-0 items-center gap-0.5">
                  {index > 0 && <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                  {here
                    ? <span aria-current="location" className="truncate px-1.5 py-0.5 font-medium">{crumb.name}</span>
                    : <button type="button" disabled={loading} onClick={() => open(crumb.cursor)}
                      className="truncate rounded px-1.5 py-0.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{crumb.name}</button>}
                </li>
              })}
            </ol>
          </nav>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter folders" aria-label="Filter folders" className="h-9 pl-8 text-sm" />
        </div>
        <div className="max-h-64 min-h-32 overflow-y-auto rounded-md border p-1">
          {loading ? <p role="status" className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading folders…</p>
            : folders.error ? <div className="p-3"><p role="alert" className="text-sm text-destructive">{folders.error.message}</p><Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { void folders.refetch() }}>Try again</Button></div>
            : shown.length ? shown.map(folder => {
              const isHighlighted = highlighted?.id === folder.id
              return <div key={folder.id} className={cn('flex items-center rounded', isHighlighted ? 'bg-accent text-accent-foreground' : 'hover:bg-muted')}>
                <button type="button" aria-pressed={isHighlighted} onClick={() => setHighlighted(isHighlighted ? null : folder)} onDoubleClick={() => open(folder.cursor)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Folder className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{folder.name}</span>
                </button>
                <Button type="button" variant="ghost" size="icon" className="mr-0.5 h-8 w-8 shrink-0" aria-label={`Open ${folder.name}`} onClick={() => open(folder.cursor)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            }) : <p className="p-3 text-sm text-muted-foreground">{query && listed.length ? `No folders match “${filter.trim()}”` : `No folders in ${crumbs[crumbs.length - 1].name}`}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setBrowsing(false)}>Cancel</Button>
          <Button type="button" className="min-w-0" disabled={!folders.data || loading || !!folders.error || disabled || target === null}
            onClick={() => { if (target === null) return; setChosen(target); onChange(target); setBrowsing(false) }}>
            <span className="truncate">{confirmLabel ?? 'Select a folder'}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
