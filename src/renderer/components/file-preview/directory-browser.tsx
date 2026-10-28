import { Fragment, type ReactNode } from 'react'
import { AlertCircle, ChevronRight, Loader2, Search } from 'lucide-react'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { FolderEntriesError, type useFolderEntries, type FolderEntry } from '@renderer/hooks/use-folder-entries'
import { cn } from '@shared/lib/utils/cn'

export interface DirectoryBrowserState {
  rootPath: string
  expandedPaths: string[]
  selectedPath?: string
  query: string
}

interface DirectoryBrowserProps {
  folder: DirectoryBrowserState
  useEntries: (path: string, enabled: boolean) => Pick<ReturnType<typeof useFolderEntries>, 'data' | 'isLoading' | 'error'> & { refetch: () => unknown }
  onToggle: (path: string) => void
  onOpenFile: (entry: FolderEntry) => void
  onQueryChange: (query: string) => void
  wrapEntry?: (entry: FolderEntry, children: ReactNode) => ReactNode
}

function errorMessage(error: unknown): string {
  if (error instanceof FolderEntriesError) {
    if (error.status === 404) return 'This folder is no longer available.'
    if (error.status === 403) return "You don't have permission to view this folder."
    return error.message
  }
  return 'The folder could not be loaded.'
}

function matchesQuery(entry: FolderEntry, query: string): boolean {
  if (!query) return true
  // Keep directories visible: search is deliberately limited to lazily loaded
  // entries, so hiding a parent would also hide matching loaded descendants.
  return entry.type === 'directory' || entry.name.toLocaleLowerCase().includes(query)
}

function HighlightedEntryName({ name, query }: { name: string; query: string }) {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return <span className="truncate">{name}</span>

  const normalizedName = name.toLocaleLowerCase()
  const parts: React.ReactNode[] = []
  let cursor = 0
  let matchIndex = normalizedName.indexOf(normalizedQuery)

  while (matchIndex >= 0) {
    if (matchIndex > cursor) parts.push(name.slice(cursor, matchIndex))
    const matchEnd = matchIndex + normalizedQuery.length
    parts.push(
      <mark
        key={`${matchIndex}-${matchEnd}`}
        className="rounded-sm bg-amber-200/80 text-inherit dark:bg-amber-800/60"
      >
        {name.slice(matchIndex, matchEnd)}
      </mark>,
    )
    cursor = matchEnd
    matchIndex = normalizedName.indexOf(normalizedQuery, cursor)
  }

  if (parts.length === 0) return <span className="truncate">{name}</span>
  if (cursor < name.length) parts.push(name.slice(cursor))
  return <span className="truncate">{parts}</span>
}

function FolderDirectory({ folder, path, depth, useEntries, onToggle, onOpenFile, wrapEntry }: Omit<DirectoryBrowserProps, 'onQueryChange'> & { path: string; depth: number }) {
  const isRoot = path === folder.rootPath
  const isExpanded = isRoot || folder.expandedPaths.includes(path)
  const { data, isLoading, error, refetch } = useEntries(path, isExpanded)
  const wrap = (entry: FolderEntry, children: ReactNode) => wrapEntry ? wrapEntry(entry, children) : children

  if (!isExpanded) return null

  if (isLoading) {
    return (
      <div
        className="flex h-7 items-center gap-1.5 text-[11px] text-muted-foreground"
        style={{ paddingLeft: `${depth * 16 + 14}px` }}
      >
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        Loading…
      </div>
    )
  }

  if (error) {
    return (
      <div
        className="flex items-center gap-1.5 py-1 pr-2 text-[11px] text-muted-foreground"
        style={{ paddingLeft: `${depth * 16 + 14}px` }}
        role="alert"
      >
        <AlertCircle className="h-2.5 w-2.5 shrink-0" />
        <span className="min-w-0 flex-1">{errorMessage(error)}</span>
        <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    )
  }

  const query = folder.query.trim().toLocaleLowerCase()
  const entries = (data?.entries ?? []).filter(entry => matchesQuery(entry, query))

  if (entries.length === 0) {
    return isRoot ? (
      <div className="px-3 py-8 text-center text-xs text-muted-foreground">
        {query ? 'No matching files in this folder.' : 'This folder is empty.'}
      </div>
    ) : null
  }

  return (
    <>
      {entries.map(entry => {
        const selected = folder.selectedPath === entry.path
        const entryDepth = depth
        if (entry.type === 'directory') {
          const expanded = folder.expandedPaths.includes(entry.path)
          return (
            <div key={entry.path}>
              {wrap(entry,
                <button
                  type="button"
                  className={cn(
                    'flex h-7 w-full items-center gap-1.5 rounded pr-2 text-left text-xs hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    selected && 'bg-muted',
                  )}
                  style={{ paddingLeft: `${entryDepth * 16 + 10}px` }}
                  onClick={() => onToggle(entry.path)}
                  aria-expanded={expanded}
                  data-testid="folder-entry"
                  data-entry-type="directory"
                  data-entry-path={entry.path}
                >
                  <ChevronRight
                    className={cn(
                      'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
                      expanded && 'rotate-90',
                    )}
                  />
                  <HighlightedEntryName name={entry.name} query={folder.query} />
                </button>
              )}
              {expanded && (
                <FolderDirectory
                  folder={folder}
                  path={entry.path}
                  depth={entryDepth + 1}
                  useEntries={useEntries}
                  onToggle={onToggle}
                  onOpenFile={onOpenFile}
                  wrapEntry={wrapEntry}
                />
              )}
            </div>
          )
        }

        return (
          <Fragment key={entry.path}>{wrap(entry,
            <button
              type="button"
              className={cn(
                'flex h-7 w-full items-center gap-1.5 rounded pr-2 text-left text-xs hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected && 'bg-muted',
              )}
              style={{ paddingLeft: `${entryDepth * 16 + 30}px` }}
              onClick={() => onOpenFile(entry)}
              data-testid="folder-entry"
              data-entry-type="file"
              data-entry-path={entry.path}
            >
              <span aria-hidden="true" className="shrink-0">
                <FileTypeIcon filename={entry.name} size="sm" className="text-muted-foreground" />
              </span>
              <HighlightedEntryName name={entry.name} query={folder.query} />
            </button>
          )}</Fragment>
        )
      })}
      {data?.truncated && (
        <div className="px-3 py-1.5 text-[11px] text-muted-foreground">
          Showing the first {data.entries.length.toLocaleString()} {data.entries.length === 1 ? 'entry' : 'entries'}.
        </div>
      )}
    </>
  )
}

/** The same lazy tree, filtering and selection for workspace folders and mounted sources. */
export function DirectoryBrowser({ folder, onQueryChange, ...props }: DirectoryBrowserProps) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="folder-browser">
      <div className="relative shrink-0 px-2 py-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={folder.query}
          onChange={event => onQueryChange(event.target.value)}
          placeholder="Filter files..."
          aria-label="Filter files"
          className="h-8 rounded-lg pl-8 text-xs"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
        <FolderDirectory
          folder={folder}
          path={folder.rootPath}
          depth={0}
          {...props}
        />
      </div>
    </div>
  )
}
