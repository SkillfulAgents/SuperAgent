import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight, Folder, FolderOpen, Loader2, Plus, Search } from 'lucide-react'
import { folderNameError, type VolumeFolders } from '@shared/lib/volumes/volume-folders-schema'
import { useCreateVolumeFolder, useVolumeFolders } from '@renderer/hooks/use-volume-folders'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { HighlightMatch } from '@renderer/components/ui/highlight-match'
import { Input } from '@renderer/components/ui/input'
import { isComposing } from '@renderer/lib/enter-key'
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
  /** Whether the picker offers to make a new one at `cursor`. Only a source whose type can create sets it. */
  canCreate?(cursor: Cursor): boolean
  /** What the source lists and makes, in the picker's words: "drive", or "folder" when unset. */
  noun?: string
  /** The setup field's label, when not "Select folder location". */
  fieldLabel?: string
  /** Whether a listed row can be opened. Unset means every row can. */
  canOpen?(cursor: Cursor): boolean
}

/**
 * A drive set-up's folder field: one button that reads as the location chosen
 * (or "Select folder" before one is), with a chevron to say it opens a picker.
 * The field's label and its value together name it.
 */
export function FolderLocationField({ location, onClick, disabled, label = 'Select folder location', placeholder = 'Select folder' }: { location: string | null; onClick: () => void; disabled: boolean; label?: string; placeholder?: string }) {
  const id = useId()
  return <div className="space-y-2">
    <p id={`${id}-label`} className="text-sm font-medium">{label}</p>
    <Button type="button" variant="outline" className="h-auto min-h-10 w-full justify-start gap-2 py-2 text-left font-normal" disabled={disabled}
      aria-labelledby={`${id}-label ${id}-value`} title={location ?? undefined} onClick={onClick}>
      <FolderOpen className="h-4 w-4 shrink-0" />
      <span id={`${id}-value`} className={cn('min-w-0 flex-1 truncate', location === null && 'text-muted-foreground')}
        data-testid={location !== null ? 'selected-volume-folder' : undefined}>{location ?? placeholder}</span>
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
  // The name being typed for a new folder or drive, or null while its row is closed.
  const [naming, setNaming] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  // Where focus goes once it is on screen: New folder when its row closes, or the folder just made, never the dialog.
  const [focusTarget, setFocusTarget] = useState<'new-folder' | { folderId: string } | null>(null)
  const focusOnMount = useCallback((element: HTMLElement | null) => { if (element) { element.focus(); setFocusTarget(null) } }, [])
  const query = source.query(accountId, cursor)
  const folders = useVolumeFolders(source, query, browsing)
  const create = useCreateVolumeFolder(source)
  const crumbs = source.crumbs(cursor)
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2].cursor : null
  const listed = folders.data ? source.folders(folders.data, cursor) : []
  const filterQuery = filter.trim().toLocaleLowerCase()
  const shown = listed.filter(folder => folder.name.toLocaleLowerCase().includes(filterQuery))

  // Opening inside the first folder happens once per opening of the picker, so stepping back up to the top stays there.
  const entered = useRef(false)
  const entering = browsing && !!source.opensInFirst && !entered.current && selected === null && crumbs.length === 1 && !folders.error
  useEffect(() => {
    if (!entering || !folders.data || folders.isFetching) return
    entered.current = true
    const first = source.folders(folders.data, cursor)[0]
    if (first) { setCursor(first.cursor); setFilter('') }
  }, [entering, folders.data, folders.isFetching, source, cursor])

  const closeNaming = (refocusAfter = true) => { setNaming(null); setNameError(null); create.reset(); setFocusTarget(refocusAfter ? 'new-folder' : null) }
  const open = (to: Cursor) => { setCursor(to); setHighlighted(null); setFilter(''); closeNaming(false) }
  const submitName = () => {
    // Nothing is made into a listing that failed to load: Try again comes first.
    if (naming === null || create.isPending || folders.error) return
    if (!naming.trim()) return closeNaming()
    const error = folderNameError(naming)
    setNameError(error)
    if (error) return
    create.mutate({ query, name: naming.trim() }, {
      onSuccess: folder => {
        setNaming(null)
        setFilter('')
        setFocusTarget({ folderId: folder.id })
        setHighlighted(source.folders({ folders: [folder] }, cursor)[0])
      },
    })
  }
  const noun = source.noun ?? 'folder'
  // Use only acts on a highlighted row that is on screen, whether typing or a refreshed listing hid it.
  const visible = shown.find(folder => folder.id === highlighted?.id) ?? null
  const choice = visible && source.confirmLabel(visible.cursor) !== null ? visible : null
  const target = choice ? choice.cursor : source.confirmLabel(cursor) !== null ? cursor : null
  const confirmLabel = choice ? `Use “${choice.name}”` : source.confirmLabel(cursor)
  const loading = folders.isFetching || entering
  // While a folder is being made the picker stays where it was asked for, so the result lands there.
  const moving = loading || create.isPending
  // Closing forgets a finished create, so only the reopen right after it keeps its place.
  const close = () => { setBrowsing(false); if (!create.isPending) create.reset() }

  return <>
    <FolderLocationField location={selected} disabled={disabled} label={source.fieldLabel} placeholder={source.noun && `Select a ${noun}`} onClick={() => {
      // Reopened after a folder was being made, the picker is still where it was made, with its outcome.
      if (create.isIdle) { entered.current = false; open(chosen) }
      setBrowsing(true)
    }} />
    <Dialog open={browsing} onOpenChange={next => { if (next) setBrowsing(true); else close() }}>
      <DialogContent className="sm:max-w-lg" data-testid={`${source.type}-folder-picker`}
        onEscapeKeyDown={event => {
          // Escape that cancels an input-method candidate is the input method's, not the picker's.
          if (isComposing(event)) return event.preventDefault()
          if (naming !== null) { event.preventDefault(); if (!create.isPending) closeNaming() }
        }}>
        <DialogHeader>
          <DialogTitle>{source.title}</DialogTitle>
          <DialogDescription>{source.description}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 items-center gap-1 rounded-md bg-muted px-1 py-1">
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label="Parent folder" disabled={parent === null || moving}
            onClick={() => { if (parent !== null) open(parent) }}><ArrowLeft className="h-4 w-4" /></Button>
          <nav aria-label="Folder path" className="min-w-0 flex-1">
            <ol className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm">
              {crumbs.map((crumb, index) => {
                const here = index === crumbs.length - 1
                return <li key={index} className="flex min-w-0 items-center gap-0.5">
                  {index > 0 && <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                  {here
                    ? <span aria-current="location" className="truncate px-1.5 py-0.5 font-medium">{crumb.name}</span>
                    : <button type="button" disabled={moving} onClick={() => open(crumb.cursor)}
                      className="truncate rounded px-1.5 py-0.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{crumb.name}</button>}
                </li>
              })}
            </ol>
          </nav>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={event => setFilter(event.target.value)} placeholder={`Filter ${noun}s`} aria-label={`Filter ${noun}s`} className="h-9 pl-8 text-sm" />
        </div>
        <div className="min-h-32 rounded-md border p-1">
          <div className="max-h-64 overflow-y-auto">
            {loading ? <p role="status" className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading {noun}s…</p>
              : folders.error ? <div className="p-3"><p role="alert" className="text-sm text-destructive">{folders.error.message}</p><Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { void folders.refetch() }}>Try again</Button></div>
              : shown.length ? shown.map(folder => {
                const isHighlighted = highlighted?.id === folder.id
                return <div key={folder.id} className={cn('flex items-center rounded', isHighlighted ? 'bg-accent text-accent-foreground' : 'hover:bg-muted')}>
                  <button type="button" aria-pressed={isHighlighted} disabled={create.isPending} ref={typeof focusTarget === 'object' && focusTarget?.folderId === folder.id ? focusOnMount : undefined} onClick={() => setHighlighted(isHighlighted ? null : folder)} onDoubleClick={() => { if (source.canOpen?.(folder.cursor) ?? true) open(folder.cursor); else setHighlighted(folder) }}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Folder className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate"><HighlightMatch text={folder.name} query={filter.trim()} /></span>
                  </button>
                  {(source.canOpen?.(folder.cursor) ?? true) && <Button type="button" variant="ghost" size="icon" className="mr-0.5 h-8 w-8 shrink-0" aria-label={`Open ${folder.name}`} disabled={create.isPending} onClick={() => open(folder.cursor)}>
                    <ChevronRight className="h-4 w-4" />
                  </Button>}
                </div>
              }) : <p className="p-3 text-sm text-muted-foreground">{filterQuery && listed.length ? `No ${noun}s match “${filter.trim()}”` : `No ${noun}s in ${crumbs[crumbs.length - 1].name}`}</p>}
          </div>
          {source.canCreate?.(cursor) && (naming !== null || (!loading && !folders.error)) && (naming === null
            ? <button type="button" ref={focusTarget === 'new-folder' ? focusOnMount : undefined} onClick={() => setNaming('')}
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Plus className="h-4 w-4 shrink-0" />New {noun}
            </button>
            : <div className="px-3 py-0.5">
              <div className="flex items-center gap-2">
                {create.isPending ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Folder className="h-4 w-4 shrink-0" />}
                <Input autoFocus value={naming} readOnly={create.isPending} aria-label={`New ${noun} name`} placeholder="Name" className="h-8 px-2 text-sm aria-[invalid=true]:border-destructive"
                  aria-invalid={!!(nameError ?? create.error)}
                  onChange={event => { setNaming(event.target.value); setNameError(null); create.reset() }}
                  onKeyDown={event => { if (event.key === 'Enter' && !isComposing(event.nativeEvent)) { event.preventDefault(); submitName() } }} />
              </div>
              {(nameError ?? create.error?.message) && <p role="alert" className="mt-1 pl-6 text-xs text-destructive">{nameError ?? create.error?.message}</p>}
            </div>)}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>Cancel</Button>
          <Button type="button" className="min-w-0" disabled={!folders.data || moving || !!folders.error || disabled || target === null}
            onClick={() => {
              if (target === null) return
              // A row that can't be opened is chosen, not entered: the picker reopens where it was.
              setChosen(choice && !(source.canOpen?.(choice.cursor) ?? true) ? cursor : target)
              onChange(target); create.reset(); setBrowsing(false)
            }}>
            <span className="truncate">{confirmLabel ?? `Select a ${noun}`}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
