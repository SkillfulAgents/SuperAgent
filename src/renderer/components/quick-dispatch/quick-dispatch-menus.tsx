import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AtSign, Check, FileIcon, FolderOpen, Loader2, Search } from 'lucide-react'
import { cn } from '@shared/lib/utils'
import { ModelFamilyList } from '@renderer/components/messages/model-family-list'
import { findCatalogModel, type ComposerOptionsState } from '@renderer/components/messages/composer-options'
import { EffortSection, useEffortClamp } from '@renderer/components/messages/effort-slider'
import { EFFORT_LEVELS } from '@shared/lib/container/types'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import { readLocalFileAsFile } from '@renderer/lib/read-local-file'

// Inline, full-width menus for the quick-dispatch launcher. Unlike the main
// app's floating popovers, these render INSIDE the panel's flex column so the
// frameless window grows to fit them (Raycast-style) — the whole frosted area
// is filled by the menu, never an empty frosted surround.

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pt-1 pb-1 text-[11px] font-medium text-muted-foreground/70">
      {children}
    </div>
  )
}

function activityTime(a: ApiAgent): number {
  return a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0
}

export function AgentMenu({
  agents,
  selectedSlug,
  onSelect,
  maxHeight,
}: {
  agents: ApiAgent[]
  selectedSlug: string | undefined
  onSelect: (slug: string) => void
  /** Caps the scrollable list height (inline style — guaranteed, no Tailwind purge risk). */
  maxHeight: number
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    // `preventScroll` is LOAD-BEARING: the search box sits below the fold while
    // the window is still growing to fit the menu, so a normal focus would
    // scroll the whole panel up to reveal it — shoving the text input off the
    // top of the window (and freezing the auto-resize at the wrong height).
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
  }, [])

  const ordered = useMemo(() => [...agents].sort((a, b) => activityTime(b) - activityTime(a)), [agents])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? ordered.filter((a) => a.name.toLowerCase().includes(q)) : ordered
  }, [ordered, query])

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search agents…"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          data-testid="quick-dispatch-agent-search"
        />
      </div>
      <div className="overflow-y-auto p-1" style={{ maxHeight }}>
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">No agents</div>
        ) : (
          filtered.map((agent) => (
            <button
              key={agent.slug}
              type="button"
              onClick={() => onSelect(agent.slug)}
              data-testid="quick-dispatch-agent-option"
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent',
                agent.slug === selectedSlug && 'bg-accent',
              )}
            >
              <AtSign className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{agent.name}</span>
              {agent.slug === selectedSlug && <Check className="ml-auto h-3.5 w-3.5 shrink-0" />}
            </button>
          ))
        )}
      </div>
    </div>
  )
}

export function ModelEffortMenu({ state, maxHeight }: { state: ComposerOptionsState; maxHeight: number }) {
  const { effort, setEffort, model, setModel, catalog, webProvider } = state
  const selected =
    findCatalogModel(model, catalog) ?? catalog.find((m) => m.family === 'sonnet' && m.isLatest) ?? catalog[0]
  const efforts = EFFORT_LEVELS.filter((l) => (selected ? selected.supportedEfforts.includes(l) : true))
  // Without the clamp this menu kept (and dispatched) an unsupported effort
  // after a model switch, while the slider silently rendered at Low.
  useEffortClamp(selected, effort, setEffort)

  return (
    // Only the model list scrolls; the effort section is pinned to the bottom so
    // it's always reachable however long the catalog is. `maxHeight` (not a
    // fixed height) keeps the menu content-sized when short — no dead gap above
    // the pinned effort section; `min-h-0` lets the list actually shrink to scroll.
    <div className="flex flex-col" style={{ maxHeight }}>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pt-2">
        {/* webProvider silences the web-tools warning when a configured host
            vendor already makes web tools work on any model — without it this
            picker contradicted the composer's. */}
        <ModelFamilyList header="Model" catalog={catalog} value={model} onPick={setModel} webProvider={webProvider} />
      </div>
      <div className="shrink-0 px-1 pb-1 pt-2">
        <EffortSection levels={efforts} value={effort} onChange={setEffort} />
      </div>
    </div>
  )
}

interface RecentFile {
  name: string
  path: string
  thumbnail?: string
}

export function AttachMenu({
  onFileSelect,
  onFolderSelect,
  onRecentFileAttach,
}: {
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void
  onFolderSelect: (e: React.ChangeEvent<HTMLInputElement>) => void
  onRecentFileAttach: (file: File) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const [recent, setRecent] = useState<RecentFile[]>([])
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const isElectron = !!window.electronAPI?.getRecentFiles

  useEffect(() => {
    if (!isElectron) return
    let cancelled = false
    window.electronAPI!.getRecentFiles(5)
      .then((files) => {
        if (!cancelled) setRecent(files)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [isElectron])

  const handleRecent = useCallback(
    async (filePath: string) => {
      setLoadingPath(filePath)
      try {
        const file = await readLocalFileAsFile(filePath)
        if (file) onRecentFileAttach(file)
      } finally {
        setLoadingPath(null)
      }
    },
    [onRecentFileAttach],
  )

  return (
    <div className="p-1">
      <input ref={fileRef} type="file" multiple className="hidden" onChange={onFileSelect} />
      <input
        ref={folderRef}
        type="file"
        className="hidden"
        onChange={onFolderSelect}
        {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
      />
      {recent.length > 0 && (
        <>
          <SectionHeader>Recent</SectionHeader>
          {recent.map((f) => (
            <button
              key={f.path}
              type="button"
              disabled={loadingPath !== null}
              onClick={() => handleRecent(f.path)}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50"
            >
              {loadingPath === f.path ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              ) : f.thumbnail ? (
                <img src={f.thumbnail} alt="" className="h-5 w-5 shrink-0 rounded-sm object-cover" />
              ) : (
                <FileTypeIcon filename={f.name} size={14} />
              )}
              <span className="truncate text-xs">{f.name}</span>
            </button>
          ))}
        </>
      )}
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
      >
        <FileIcon className="h-4 w-4" /> Files
      </button>
      <button
        type="button"
        onClick={() => folderRef.current?.click()}
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
      >
        <FolderOpen className="h-4 w-4" /> Folder
      </button>
    </div>
  )
}
