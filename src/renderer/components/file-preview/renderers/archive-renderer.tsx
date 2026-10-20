import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Loader2 } from 'lucide-react'
import { guessMimeType } from '@shared/lib/utils/mime'
import type { FolderEntriesResponse, FolderEntry } from '@renderer/hooks/use-folder-entries'
import { FileBrowser, type FileSource, type OpenedFile } from '../file-browser'
import { downloadZip, listZip, MAX_ZIP_ENTRIES, unzipEntry, type ZipEntry } from './zip-archive'
import { UnsupportedRenderer } from './unsupported-renderer'

const REASONS = {
  'too-large': 'Larger than 5 MB.',
  'too-many': 'Too many files to list.',
  unreadable: "Can't read this file as a zip.",
} as const

const ENTRY_REASONS = {
  'too-much': 'Too much content to preview. Download the zip to open it.',
  unreadable: "Can't read this file. Download the zip to open it.",
} as const

/** Entries per folder, as the workspace folder listing caps them. */
const MAX_FOLDER_ENTRIES = 1_000

type Loaded = { ok: true; bytes: Uint8Array; folders: Map<string, FolderEntry[]> } | { ok: false; reason: keyof typeof REASONS }

async function loadZip(url: string, signal: AbortSignal): Promise<Loaded> {
  const bytes = await downloadZip(url, signal)
  if (!bytes) return { ok: false, reason: 'too-large' }
  const listing = listZip(bytes)
  if (!listing.ok) return listing
  const folders = archiveFolders(listing.names)
  return folders ? { ok: true, bytes, folders } : { ok: false, reason: 'too-many' }
}

/** Files macOS adds when it zips a folder, hidden as Archive Utility hides them. */
function isMacJunk(name: string): boolean {
  return name.startsWith('__MACOSX/') || name === '.DS_Store' || name.endsWith('/.DS_Store')
}

/**
 * Each folder's entries, keyed by folder path ('' is the top), sorted as workspace folders are.
 * Adds the folders a zip implies but does not list, so every file sits under its folder.
 * A file keeps its name in the zip as its path, since that is what opening it looks up.
 * Null when the folders it adds take the count past the listing limit.
 */
export function archiveFolders(names: readonly string[]): Map<string, FolderEntry[]> | null {
  const folders = new Map<string, Map<string, FolderEntry>>([['', new Map()]])
  let count = 0
  for (const name of names) {
    if (isMacJunk(name)) continue
    const parts = name.split('/').filter(Boolean)
    let parent = ''
    for (const [i, part] of parts.entries()) {
      const type = name.endsWith('/') || i < parts.length - 1 ? 'directory' : 'file'
      const path = type === 'file' ? name : parent ? `${parent}/${part}` : part
      const siblings = folders.get(parent)
      // A folder and a file can share a name in a zip but not on disk. The folder wins, as unzipping would leave it.
      if (siblings && !siblings.has(path) && !(type === 'file' && folders.has(path))) {
        if (++count > MAX_ZIP_ENTRIES) return null
        siblings.set(path, { name: part, path, type })
      }
      if (type === 'directory' && !folders.has(path)) {
        folders.set(path, new Map())
        siblings?.set(path, { name: part, path, type })
      }
      parent = path
    }
  }
  return new Map([...folders].map(([path, entries]) => [path, [...entries.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })]))
}

function folderResponse(folders: Map<string, FolderEntry[]>, path: string): FolderEntriesResponse {
  const entries = folders.get(path) ?? []
  return { root: '', path, entries: entries.slice(0, MAX_FOLDER_ENTRIES), truncated: entries.length > MAX_FOLDER_ENTRIES }
}

/** The open entry, unpacked when opened, as a URL that lives only while it is shown. No download: it is not a workspace file. */
export function useZipFile(bytes: Uint8Array, path: string | null): OpenedFile | null {
  const unpacked = useMemo(() => (path === null ? null : unzipEntry(bytes, path)), [bytes, path])
  // Tied to the unpack it came from, so a switch never shows the last file's URL under the next name.
  const [blob, setBlob] = useState<{ from: ZipEntry; url: string } | null>(null)
  useEffect(() => {
    if (!path || !unpacked?.ok) return
    const url = URL.createObjectURL(new Blob([unpacked.content], { type: guessMimeType(path) }))
    setBlob({ from: unpacked, url })
    return () => URL.revokeObjectURL(url)
  }, [unpacked, path])
  if (unpacked && !unpacked.ok) return { reason: ENTRY_REASONS[unpacked.reason] }
  return blob && blob.from === unpacked ? { inlineUrl: blob.url } : null
}

interface ArchiveRendererProps {
  url: string
  filePath: string
  agentSlug: string
  downloadUrl?: string
}

/** A zip as a folder: the list reads names only, and a file is unpacked when it is opened. */
export function ArchiveRenderer({ url, filePath, agentSlug, downloadUrl }: ArchiveRendererProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['file-archive', url],
    queryFn: ({ signal }) => loadZip(url, signal),
    // The URL carries the file's version, so its bytes never go stale. A refetch would let the open file and the list read different zips.
    staleTime: Infinity,
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (error || !data) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Failed to load file</span>
      </div>
    )
  }
  if (!data.ok) {
    return <UnsupportedRenderer filePath={filePath} agentSlug={agentSlug} downloadUrl={downloadUrl} reason={REASONS[data.reason]} />
  }

  const { bytes, folders } = data
  const source: FileSource = {
    useEntries(path, enabled) {
      return useQuery<FolderEntriesResponse>({
        queryKey: ['file-archive-folder', url, path],
        queryFn: () => folderResponse(folders, path),
        initialData: () => folderResponse(folders, path),
        enabled,
        staleTime: Infinity,
      })
    },
    useFile: path => useZipFile(bytes, path),
  }
  return <div className="flex h-full flex-col" data-testid="archive-renderer"><FileBrowser source={source} /></div>
}
