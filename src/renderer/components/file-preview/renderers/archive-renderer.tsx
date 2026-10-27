import { useLayoutEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle } from 'lucide-react'
import { guessMimeType } from '@shared/lib/utils/mime'
import { previewKind } from '@renderer/lib/file-types'
import { arrayBufferToBase64 } from '@renderer/lib/voice/shared/pcm'
import type { FolderEntriesResponse, FolderEntry } from '@renderer/hooks/use-folder-entries'
import { FileBrowser, type FileSource, type OpenedFile } from '../file-browser'
import { LAZY_FALLBACK } from './file-renderer'
import { downloadZip, listZip, MAX_ZIP_ENTRIES, unzipEntry } from './zip-archive'
import { NO_PREVIEW, UnsupportedRenderer } from './unsupported-renderer'

const REASONS = {
  'too-large': 'Larger than 5 MB.',
  'too-many': 'Too many files to list.',
  unreadable: "Can't read this file as a zip.",
} as const

const ENTRY_REASONS = {
  'too-much': 'Too much content to preview. Download the zip to open it.',
  encrypted: 'Password-protected. Download the zip to open it.',
  unreadable: "Can't read this file. Download the zip to open it.",
} as const

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
 * Names arrive as `listZip` gives them, so a file's path is the name opening looks up.
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
      const path = parent ? `${parent}/${part}` : part
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

/** The whole folder: the listing is already in memory, so nothing is held back from the filter. */
function folderResponse(folders: Map<string, FolderEntry[]>, path: string): FolderEntriesResponse {
  return { root: '', path, entries: folders.get(path) ?? [], truncated: false }
}

const INERT_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon', 'application/pdf', 'application/zip', 'application/json', 'application/octet-stream',
  'text/plain', 'text/csv', 'text/markdown', 'text/yaml', 'text/css', 'text/javascript', 'text/typescript', 'text/x-python', 'text/x-shellscript',
])

/** Types a browser shows as text, plays, or downloads when opened in a tab of their own, never running script. */
function isInert(type: string): boolean {
  return INERT_TYPES.has(type) || /^(audio|video)\//.test(type)
}

/** Chromium's longest URL. A frame given a longer one loads nothing. */
const MAX_URL = 2 * 1024 * 1024

/**
 * An entry as a URL its renderer can load, unpacked only when a renderer can show it.
 * A blob: URL belongs to the app's origin, so only inert types get one. Anything else,
 * HTML and SVG included, gets a data: URL, which has no origin to run as.
 */
function openEntry(bytes: Uint8Array, path: string): OpenedFile {
  if (!previewKind(path)) return { reason: NO_PREVIEW }
  const entry = unzipEntry(bytes, path)
  if (!entry.ok) return { reason: ENTRY_REASONS[entry.reason] }
  const type = guessMimeType(path)
  if (isInert(type)) return { inlineUrl: URL.createObjectURL(new Blob([entry.content], { type })) }
  const prefix = `data:${type};base64,`
  if (prefix.length + 4 * Math.ceil(entry.content.length / 3) > MAX_URL) return { reason: ENTRY_REASONS['too-much'] }
  return { inlineUrl: prefix + arrayBufferToBase64(entry.content.buffer) }
}

/**
 * Opens each entry once and keeps it at one URL while the zip is shown, so switching back
 * unpacks nothing and a nested zip keeps its key. Every URL is revoked when the view goes.
 * No download: an entry is not a workspace file.
 */
export function useZipFiles(bytes: Uint8Array | null): ((path: string) => OpenedFile) | null {
  const [opened, setOpened] = useState<{ bytes: Uint8Array; files: Map<string, OpenedFile> } | null>(null)
  // Before paint, so the list shows in the frame the bytes arrive.
  useLayoutEffect(() => {
    if (!bytes) return
    const files = new Map<string, OpenedFile>()
    setOpened({ bytes, files })
    return () => {
      for (const file of files.values()) if ('inlineUrl' in file) URL.revokeObjectURL(file.inlineUrl)
    }
  }, [bytes])
  if (!bytes || opened?.bytes !== bytes) return null
  // Opened while rendering, into the map the effect owns, so a URL from a render React drops is still revoked.
  return path => {
    let file = opened.files.get(path)
    if (!file) opened.files.set(path, (file = openEntry(bytes, path)))
    return file
  }
}

interface ArchiveRendererProps {
  url: string
  filePath: string
  downloadUrl?: string
}

/** A zip as a folder: the list reads names only, and a file is unpacked when it is opened. */
export function ArchiveRenderer({ url, filePath, downloadUrl }: ArchiveRendererProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['file-archive', url],
    queryFn: ({ signal }) => loadZip(url, signal),
    // The URL carries the file's version, so its bytes never go stale. A refetch would let the open file and the list read different zips.
    staleTime: Infinity,
    // A zip opened from another dies with the view that unpacked it, so its cache entry would only hold memory.
    gcTime: url.startsWith('blob:') ? 0 : undefined,
  })
  const open = useZipFiles(data?.ok ? data.bytes : null)

  if (isLoading) return LAZY_FALLBACK
  if (error || !data) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Failed to load file</span>
      </div>
    )
  }
  if (!data.ok) {
    return <UnsupportedRenderer filePath={filePath} downloadUrl={downloadUrl} reason={REASONS[data.reason]} />
  }
  if (!open) return LAZY_FALLBACK

  const { folders } = data
  const source: FileSource = {
    useEntries: path => ({ data: folderResponse(folders, path), isLoading: false, error: null, refetch: () => {} }),
    useFile: path => (path === null ? null : open(path)),
  }
  return <div className="flex h-full flex-col" data-testid="archive-renderer"><FileBrowser source={source} /></div>
}
