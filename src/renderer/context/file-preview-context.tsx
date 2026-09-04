import { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { getPathName } from '@shared/lib/utils/workspace-path'
import { useRouteLocation } from '@renderer/router/use-route-location'

export interface FileTab {
  kind: 'file'
  filePath: string
  agentSlug: string
  displayName: string
  description?: string
  /**
   * Cache-busting token for this tab's file URL, bumped every time the file is
   * (re)delivered or renamed. Seeded from the clock rather than 0 so a reload
   * never reuses a URL an intermediary may still be serving a stale body for —
   * the agent rewrites these files in place, so path alone is not an identity.
   */
  version: number
  /** 1-based page currently shown when this tab contains a PDF. */
  pdfPage: number
}

export interface FolderTab {
  kind: 'folder'
  rootPath: string
  agentSlug: string
  displayName: string
  expandedPaths: string[]
  selectedPath?: string
  query: string
}

export type PreviewTab = FileTab | FolderTab

/**
 * Identity of an open tab.
 *
 * The agent slug is part of it because a path on its own is not unique: two
 * agents can each have a `/workspace/report.md`, and a drawer that outlives one
 * agent — the chat-integration views, the dashboard — would otherwise treat the
 * two files as one tab, showing the first agent's bytes under the second's
 * name.
 */
export function getPreviewTabKey(tab: PreviewTab): string {
  const path = tab.kind === 'file' ? tab.filePath : tab.rootPath
  return `${tab.kind}:${getWorkspaceFileKey(tab.agentSlug, path)}`
}

/**
 * Identity of one agent's copy of a path.
 *
 * Everything the drawer keys by a file keys by this: the tab, and the comments
 * hanging off it. Keying only half the drawer by the agent would be worse than
 * keying none of it — the tabs would separate while the state behind them still
 * aliased, so feedback left on one agent's report would appear on, and be
 * submitted with, another's.
 */
export function getWorkspaceFileKey(agentSlug: string, filePath: string): string {
  return `${agentSlug}:${filePath}`
}

/** Does this tab hold that agent's copy of that path? */
function isFileTabFor(tab: PreviewTab, agentSlug: string, filePath: string): boolean {
  return tab.kind === 'file' && tab.agentSlug === agentSlug && tab.filePath === filePath
}

/** The folder equivalent: two agents can have a browser open on the same root. */
function isFolderTabFor(tab: PreviewTab, agentSlug: string, rootPath: string): tab is FolderTab {
  return tab.kind === 'folder' && tab.agentSlug === agentSlug && tab.rootPath === rootPath
}

export interface CellRef {
  /** 1-based data row index (header row excluded). */
  row: number
  /** 0-based column index, used to place the comment pin in the grid. */
  col: number
  /** Column header name (or "Column N" when the header is blank). */
  column: string
  /** Current cell value, included as context for the agent. */
  value?: string
}

// TODO should create specific types for CSV / Image (x,y) and text, and FileComment can be a union of those with a `type` field. Deeper validation - if we have x we need y etc...
export interface FileComment {
  id: string
  filePath: string
  /** Which agent's copy of `filePath` this is feedback on. */
  agentSlug: string
  text: string
  selectedText?: string
  x?: number
  y?: number
  cell?: CellRef
  /** Playback position in seconds for audio/video comments (optionally paired with x/y in-frame). */
  timestamp?: number
}

interface FilePreviewContextType {
  openTabs: PreviewTab[]
  activeTabIndex: number
  comments: Map<string, FileComment[]>
  isOpen: boolean
  commentsEnabled: boolean

  openFile: (filePath: string, agentSlug: string, description?: string) => void
  openFolder: (folderPath: string, agentSlug: string) => void
  toggleFolder: (rootPath: string, agentSlug: string, folderPath: string) => void
  setFolderQuery: (rootPath: string, agentSlug: string, query: string) => void
  selectFolderEntry: (rootPath: string, agentSlug: string, entryPath: string) => void
  renameFilePath: (oldPath: string, newPath: string, agentSlug: string) => void
  removeFilePath: (filePath: string, agentSlug: string) => void
  renameDirectoryPath: (oldPath: string, newPath: string, agentSlug: string) => void
  removeDirectoryPath: (directoryPath: string, agentSlug: string) => void
  closeTab: (tabKey: string) => void
  setActiveTab: (index: number) => void
  setPdfPage: (filePath: string, agentSlug: string, page: number) => void
  close: () => void

  /** Comments on one agent's copy of a path; the one place the key is composed. */
  commentsFor: (filePath: string, agentSlug: string) => FileComment[]
  addComment: (comment: Omit<FileComment, 'id'>) => void
  removeComment: (filePath: string, agentSlug: string, commentId: string) => void
  clearComments: (filePath: string, agentSlug: string) => void
}

const FilePreviewContext = createContext<FilePreviewContextType | null>(null)

let lastFileVersion = 0

/** Strictly increasing cache-busting token; clock-seeded, monotonic within a session. */
function nextFileVersion(): number {
  lastFileVersion = Math.max(Date.now(), lastFileVersion + 1)
  return lastFileVersion
}

/** Tab and title label for a path. */
function getDisplayName(filePath: string): string {
  return getPathName(filePath)
}

function normalizeFolderPath(folderPath: string): string {
  return folderPath === '/' ? folderPath : folderPath.replace(/\/+$/, '')
}

function isPathAtOrBelow(basePath: string, candidatePath: string): boolean {
  return candidatePath === basePath || candidatePath.startsWith(`${basePath}/`)
}

function replacePathPrefix(candidatePath: string, oldPath: string, newPath: string): string {
  return isPathAtOrBelow(oldPath, candidatePath)
    ? `${newPath}${candidatePath.slice(oldPath.length)}`
    : candidatePath
}

let commentIdCounter = 0

/** One shared empty array: a fresh [] per call would change every consumer's deps. */
const EMPTY_COMMENTS: FileComment[] = []

export function FilePreviewProvider({
  children,
  sessionId: sessionIdProp,
  commentsEnabled = true,
}: {
  children: ReactNode
  sessionId?: string | null
  commentsEnabled?: boolean
}) {
  const { view } = useRouteLocation()
  // Views that own a session (e.g. chat integrations) can pass it explicitly so
  // state clears when switching sessions; otherwise derive from the active route.
  const sessionId = sessionIdProp !== undefined ? sessionIdProp : (view.kind === 'session' ? view.id : null)

  const [openTabs, setOpenTabs] = useState<PreviewTab[]>([])
  const [activeTabIndex, setActiveTabIndex] = useState(0)
  // Keyed by getWorkspaceFileKey, not by path: see the note on that function.
  const [comments, setComments] = useState<Map<string, FileComment[]>>(new Map())
  const [isOpen, setIsOpen] = useState(false)

  // Clear state when session changes
  useEffect(() => {
    setOpenTabs([])
    setActiveTabIndex(0)
    setComments(new Map())
    setIsOpen(false)
  }, [sessionId])

  const openFile = useCallback((filePath: string, agentSlug: string, description?: string) => {
    // Minted outside the updater: React may invoke an updater more than once per
    // commit, and a token that changes between passes is a different file URL.
    const version = nextFileVersion()
    setOpenTabs(prev => {
      const existingIndex = prev.findIndex(tab => isFileTabFor(tab, agentSlug, filePath))
      if (existingIndex >= 0) {
        setActiveTabIndex(existingIndex)
        setIsOpen(true)
        const next = [...prev]
        const existing = next[existingIndex] as FileTab
        next[existingIndex] = { ...existing, version }
        return next
      }
      const newTab: FileTab = {
        kind: 'file',
        filePath,
        agentSlug,
        displayName: getDisplayName(filePath),
        description,
        version,
        pdfPage: 1,
      }
      const next = [...prev, newTab]
      setActiveTabIndex(next.length - 1)
      setIsOpen(true)
      return next
    })
  }, [])

  const openFolder = useCallback((folderPath: string, agentSlug: string) => {
    const rootPath = normalizeFolderPath(folderPath)
    setOpenTabs(prev => {
      const existingIndex = prev.findIndex(tab => isFolderTabFor(tab, agentSlug, rootPath))
      if (existingIndex >= 0) {
        setActiveTabIndex(existingIndex)
        setIsOpen(true)
        return prev
      }

      const newTab: FolderTab = {
        kind: 'folder',
        rootPath,
        agentSlug,
        displayName: getDisplayName(rootPath),
        expandedPaths: [rootPath],
        query: '',
      }
      const next = [...prev, newTab]
      setActiveTabIndex(next.length - 1)
      setIsOpen(true)
      return next
    })
  }, [])

  const toggleFolder = useCallback((rootPath: string, agentSlug: string, folderPath: string) => {
    setOpenTabs(prev => prev.map(tab => {
      if (!isFolderTabFor(tab, agentSlug, rootPath) || folderPath === rootPath) return tab
      const expanded = new Set(tab.expandedPaths)
      if (expanded.has(folderPath)) expanded.delete(folderPath)
      else expanded.add(folderPath)
      return { ...tab, expandedPaths: Array.from(expanded) }
    }))
  }, [])

  const setFolderQuery = useCallback((rootPath: string, agentSlug: string, query: string) => {
    setOpenTabs(prev => prev.map(tab => (
      isFolderTabFor(tab, agentSlug, rootPath) ? { ...tab, query } : tab
    )))
  }, [])

  const selectFolderEntry = useCallback((rootPath: string, agentSlug: string, entryPath: string) => {
    setOpenTabs(prev => prev.map(tab => (
      isFolderTabFor(tab, agentSlug, rootPath) ? { ...tab, selectedPath: entryPath } : tab
    )))
  }, [])

  const renameFilePath = useCallback((oldPath: string, newPath: string, agentSlug: string) => {
    const version = nextFileVersion()
    setOpenTabs(prev => prev.map(tab => {
      if (isFileTabFor(tab, agentSlug, oldPath)) {
        return {
          ...tab,
          filePath: newPath,
          displayName: getDisplayName(newPath),
          version,
        }
      }
      if (tab.kind === 'folder' && tab.agentSlug === agentSlug && tab.selectedPath === oldPath) {
        return { ...tab, selectedPath: newPath }
      }
      return tab
    }))
    setComments(prev => {
      const from = getWorkspaceFileKey(agentSlug, oldPath)
      const existing = prev.get(from)
      if (!existing) return prev
      const next = new Map(prev)
      next.delete(from)
      next.set(
        getWorkspaceFileKey(agentSlug, newPath),
        existing.map(comment => ({ ...comment, filePath: newPath })),
      )
      return next
    })
  }, [])

  const closeTab = useCallback((tabKey: string) => {
    setOpenTabs(prev => {
      const idx = prev.findIndex(tab => getPreviewTabKey(tab) === tabKey)
      if (idx < 0) return prev
      // The path comes off the tab rather than back out of the key: a key is an
      // identity, not a container, and it stopped being parseable the moment
      // the agent slug joined it.
      const closed = prev[idx]
      if (closed.kind === 'file') {
        const commentKey = getWorkspaceFileKey(closed.agentSlug, closed.filePath)
        setComments(current => {
          if (!current.has(commentKey)) return current
          const next = new Map(current)
          next.delete(commentKey)
          return next
        })
      }
      const next = prev.filter((_, i) => i !== idx)
      if (next.length === 0) {
        setIsOpen(false)
        setActiveTabIndex(0)
      } else {
        setActiveTabIndex(curr => {
          if (curr >= next.length) return next.length - 1
          if (curr > idx) return curr - 1
          return curr
        })
      }
      return next
    })
  }, [])

  const removeFilePath = useCallback((filePath: string, agentSlug: string) => {
    closeTab(`file:${getWorkspaceFileKey(agentSlug, filePath)}`)
    setOpenTabs(prev => prev.map(tab => (
      tab.kind === 'folder' && tab.agentSlug === agentSlug && tab.selectedPath === filePath
        ? { ...tab, selectedPath: undefined }
        : tab
    )))
  }, [closeTab])

  const renameDirectoryPath = useCallback((oldPath: string, newPath: string, agentSlug: string) => {
    const version = nextFileVersion()
    setOpenTabs(prev => prev.map(tab => {
      if (tab.agentSlug !== agentSlug) return tab
      if (tab.kind === 'file') {
        const filePath = replacePathPrefix(tab.filePath, oldPath, newPath)
        return filePath === tab.filePath
          ? tab
          : { ...tab, filePath, displayName: getDisplayName(filePath), version }
      }

      const rootPath = replacePathPrefix(tab.rootPath, oldPath, newPath)
      const expandedPaths = Array.from(new Set(
        tab.expandedPaths.map(folderPath => replacePathPrefix(folderPath, oldPath, newPath)),
      ))
      const selectedPath = tab.selectedPath
        ? replacePathPrefix(tab.selectedPath, oldPath, newPath)
        : undefined
      return {
        ...tab,
        rootPath,
        displayName: rootPath === tab.rootPath ? tab.displayName : getDisplayName(rootPath),
        expandedPaths,
        selectedPath,
      }
    }))
    setComments(prev => {
      let changed = false
      const next = new Map<string, FileComment[]>()
      for (const [key, fileComments] of prev) {
        // Every comment in a bucket shares the file it is on, so the first one
        // carries the bucket's identity — which beats parsing it back out of
        // the key, since a path may contain the separator.
        const owner = fileComments[0]
        const nextPath = owner && owner.agentSlug === agentSlug
          ? replacePathPrefix(owner.filePath, oldPath, newPath)
          : null
        if (!owner || nextPath === null || nextPath === owner.filePath) {
          next.set(key, fileComments)
          continue
        }
        changed = true
        next.set(
          getWorkspaceFileKey(agentSlug, nextPath),
          fileComments.map(comment => ({ ...comment, filePath: nextPath })),
        )
      }
      return changed ? next : prev
    })
  }, [])

  const removeDirectoryPath = useCallback((directoryPath: string, agentSlug: string) => {
    setOpenTabs(prev => {
      const next = prev
        .filter(tab => tab.agentSlug !== agentSlug || !isPathAtOrBelow(
          directoryPath,
          tab.kind === 'file' ? tab.filePath : tab.rootPath,
        ))
        .map(tab => {
          if (tab.kind !== 'folder' || tab.agentSlug !== agentSlug) return tab
          const expandedPaths = tab.expandedPaths.filter(path => !isPathAtOrBelow(directoryPath, path))
          const selectedPath = tab.selectedPath && isPathAtOrBelow(directoryPath, tab.selectedPath)
            ? undefined
            : tab.selectedPath
          return { ...tab, expandedPaths, selectedPath }
        })

      if (next.length === 0) {
        setIsOpen(false)
        setActiveTabIndex(0)
      } else {
        setActiveTabIndex(current => {
          const activeTab = prev[current]
          if (activeTab) {
            const activeKey = getPreviewTabKey(activeTab)
            const retainedIndex = next.findIndex(tab => getPreviewTabKey(tab) === activeKey)
            if (retainedIndex >= 0) return retainedIndex
          }
          return Math.min(current, next.length - 1)
        })
      }
      return next
    })
    setComments(prev => {
      const next = new Map(prev)
      let changed = false
      for (const [key, fileComments] of prev) {
        const owner = fileComments[0]
        if (!owner || owner.agentSlug !== agentSlug) continue
        if (isPathAtOrBelow(directoryPath, owner.filePath)) {
          next.delete(key)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  const setActiveTab = useCallback((index: number) => {
    setActiveTabIndex(index)
  }, [])

  const setPdfPage = useCallback((filePath: string, agentSlug: string, page: number) => {
    const nextPage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1
    setOpenTabs(prev => {
      const index = prev.findIndex(tab => isFileTabFor(tab, agentSlug, filePath))
      if (index < 0) return prev

      const file = prev[index] as FileTab
      if (file.pdfPage === nextPage) return prev

      const next = [...prev]
      next[index] = { ...file, pdfPage: nextPage }
      return next
    })
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
  }, [])

  const commentsFor = useCallback((filePath: string, agentSlug: string) => (
    comments.get(getWorkspaceFileKey(agentSlug, filePath)) ?? EMPTY_COMMENTS
  ), [comments])

  const addComment = useCallback((comment: Omit<FileComment, 'id'>) => {
    if (!commentsEnabled) return
    const id = `comment-${++commentIdCounter}`
    const key = getWorkspaceFileKey(comment.agentSlug, comment.filePath)
    setComments(prev => {
      const next = new Map(prev)
      next.set(key, [...(next.get(key) ?? []), { ...comment, id }])
      return next
    })
  }, [commentsEnabled])

  const removeComment = useCallback((filePath: string, agentSlug: string, commentId: string) => {
    const key = getWorkspaceFileKey(agentSlug, filePath)
    setComments(prev => {
      const existing = prev.get(key)
      if (!existing) return prev
      const next = new Map(prev)
      const filtered = existing.filter(c => c.id !== commentId)
      if (filtered.length === 0) next.delete(key)
      else next.set(key, filtered)
      return next
    })
  }, [])

  const clearComments = useCallback((filePath: string, agentSlug: string) => {
    const key = getWorkspaceFileKey(agentSlug, filePath)
    setComments(prev => {
      if (!prev.has(key)) return prev
      const next = new Map(prev)
      next.delete(key)
      return next
    })
  }, [])

  const value = useMemo<FilePreviewContextType>(() => ({
    openTabs,
    activeTabIndex,
    comments,
    isOpen,
    commentsEnabled,
    openFile,
    openFolder,
    toggleFolder,
    setFolderQuery,
    selectFolderEntry,
    renameFilePath,
    removeFilePath,
    renameDirectoryPath,
    removeDirectoryPath,
    closeTab,
    setActiveTab,
    setPdfPage,
    close,
    commentsFor,
    addComment,
    removeComment,
    clearComments,
  }), [openTabs, activeTabIndex, comments, isOpen, commentsEnabled, openFile, openFolder, toggleFolder, setFolderQuery, selectFolderEntry, renameFilePath, removeFilePath, renameDirectoryPath, removeDirectoryPath, closeTab, setActiveTab, setPdfPage, close, commentsFor, addComment, removeComment, clearComments])

  return (
    <FilePreviewContext.Provider value={value}>
      {children}
    </FilePreviewContext.Provider>
  )
}

export function useFilePreview(): FilePreviewContextType {
  const ctx = useContext(FilePreviewContext)
  if (!ctx) throw new Error('useFilePreview must be used within FilePreviewProvider')
  return ctx
}
