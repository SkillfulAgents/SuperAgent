import { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { useRouteLocation } from '@renderer/router/use-route-location'

export interface FileTab {
  kind: 'file'
  filePath: string
  agentSlug: string
  displayName: string
  description?: string
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

export function getPreviewTabKey(tab: PreviewTab): string {
  return tab.kind === 'file' ? `file:${tab.filePath}` : `folder:${tab.rootPath}`
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
  toggleFolder: (rootPath: string, folderPath: string) => void
  setFolderQuery: (rootPath: string, query: string) => void
  selectFolderEntry: (rootPath: string, entryPath: string) => void
  renameFilePath: (oldPath: string, newPath: string) => void
  removeFilePath: (filePath: string) => void
  renameDirectoryPath: (oldPath: string, newPath: string) => void
  removeDirectoryPath: (directoryPath: string) => void
  closeTab: (tabKey: string) => void
  setActiveTab: (index: number) => void
  setPdfPage: (filePath: string, page: number) => void
  close: () => void

  addComment: (comment: Omit<FileComment, 'id'>) => void
  removeComment: (filePath: string, commentId: string) => void
  clearComments: (filePath: string) => void
}

const FilePreviewContext = createContext<FilePreviewContextType | null>(null)

function getDisplayName(filePath: string): string {
  const normalized = filePath.replace(/\/+$/, '')
  return normalized.split('/').pop() || normalized
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
    setOpenTabs(prev => {
      const existingIndex = prev.findIndex(tab => tab.kind === 'file' && tab.filePath === filePath)
      if (existingIndex >= 0) {
        setActiveTabIndex(existingIndex)
        setIsOpen(true)
        const next = [...prev]
        const existing = next[existingIndex] as FileTab
        next[existingIndex] = { ...existing, version: existing.version + 1 }
        return next
      }
      const newTab: FileTab = {
        kind: 'file',
        filePath,
        agentSlug,
        displayName: getDisplayName(filePath),
        description,
        version: 0,
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
      const existingIndex = prev.findIndex(tab => tab.kind === 'folder' && tab.rootPath === rootPath)
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

  const toggleFolder = useCallback((rootPath: string, folderPath: string) => {
    setOpenTabs(prev => prev.map(tab => {
      if (tab.kind !== 'folder' || tab.rootPath !== rootPath || folderPath === rootPath) return tab
      const expanded = new Set(tab.expandedPaths)
      if (expanded.has(folderPath)) expanded.delete(folderPath)
      else expanded.add(folderPath)
      return { ...tab, expandedPaths: Array.from(expanded) }
    }))
  }, [])

  const setFolderQuery = useCallback((rootPath: string, query: string) => {
    setOpenTabs(prev => prev.map(tab => (
      tab.kind === 'folder' && tab.rootPath === rootPath ? { ...tab, query } : tab
    )))
  }, [])

  const selectFolderEntry = useCallback((rootPath: string, entryPath: string) => {
    setOpenTabs(prev => prev.map(tab => (
      tab.kind === 'folder' && tab.rootPath === rootPath ? { ...tab, selectedPath: entryPath } : tab
    )))
  }, [])

  const renameFilePath = useCallback((oldPath: string, newPath: string) => {
    setOpenTabs(prev => prev.map(tab => {
      if (tab.kind === 'file' && tab.filePath === oldPath) {
        return {
          ...tab,
          filePath: newPath,
          displayName: getDisplayName(newPath),
          version: tab.version + 1,
        }
      }
      if (tab.kind === 'folder' && tab.selectedPath === oldPath) {
        return { ...tab, selectedPath: newPath }
      }
      return tab
    }))
    setComments(prev => {
      const existing = prev.get(oldPath)
      if (!existing) return prev
      const next = new Map(prev)
      next.delete(oldPath)
      next.set(newPath, existing.map(comment => ({ ...comment, filePath: newPath })))
      return next
    })
  }, [])

  const closeTab = useCallback((tabKey: string) => {
    const closedFilePath = tabKey.startsWith('file:') ? tabKey.slice('file:'.length) : null
    setOpenTabs(prev => {
      const idx = prev.findIndex(tab => getPreviewTabKey(tab) === tabKey)
      if (idx < 0) return prev
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
    if (closedFilePath) {
      setComments(prev => {
        const next = new Map(prev)
        next.delete(closedFilePath!)
        return next
      })
    }
  }, [])

  const removeFilePath = useCallback((filePath: string) => {
    closeTab(`file:${filePath}`)
    setOpenTabs(prev => prev.map(tab => (
      tab.kind === 'folder' && tab.selectedPath === filePath
        ? { ...tab, selectedPath: undefined }
        : tab
    )))
  }, [closeTab])

  const renameDirectoryPath = useCallback((oldPath: string, newPath: string) => {
    setOpenTabs(prev => prev.map(tab => {
      if (tab.kind === 'file') {
        const filePath = replacePathPrefix(tab.filePath, oldPath, newPath)
        return filePath === tab.filePath
          ? tab
          : { ...tab, filePath, displayName: getDisplayName(filePath), version: tab.version + 1 }
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
      for (const [filePath, fileComments] of prev) {
        const nextPath = replacePathPrefix(filePath, oldPath, newPath)
        changed ||= nextPath !== filePath
        next.set(nextPath, nextPath === filePath
          ? fileComments
          : fileComments.map(comment => ({ ...comment, filePath: nextPath })))
      }
      return changed ? next : prev
    })
  }, [])

  const removeDirectoryPath = useCallback((directoryPath: string) => {
    setOpenTabs(prev => {
      const next = prev
        .filter(tab => !isPathAtOrBelow(
          directoryPath,
          tab.kind === 'file' ? tab.filePath : tab.rootPath,
        ))
        .map(tab => {
          if (tab.kind !== 'folder') return tab
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
      for (const filePath of next.keys()) {
        if (isPathAtOrBelow(directoryPath, filePath)) {
          next.delete(filePath)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  const setActiveTab = useCallback((index: number) => {
    setActiveTabIndex(index)
  }, [])

  const setPdfPage = useCallback((filePath: string, page: number) => {
    const nextPage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1
    setOpenTabs(prev => {
      const index = prev.findIndex(tab => tab.kind === 'file' && tab.filePath === filePath)
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

  const addComment = useCallback((comment: Omit<FileComment, 'id'>) => {
    if (!commentsEnabled) return
    const id = `comment-${++commentIdCounter}`
    setComments(prev => {
      const next = new Map(prev)
      const existing = next.get(comment.filePath) || []
      next.set(comment.filePath, [...existing, { ...comment, id }])
      return next
    })
  }, [commentsEnabled])

  const removeComment = useCallback((filePath: string, commentId: string) => {
    setComments(prev => {
      const next = new Map(prev)
      const existing = next.get(filePath)
      if (existing) {
        const filtered = existing.filter(c => c.id !== commentId)
        if (filtered.length === 0) next.delete(filePath)
        else next.set(filePath, filtered)
      }
      return next
    })
  }, [])

  const clearComments = useCallback((filePath: string) => {
    setComments(prev => {
      const next = new Map(prev)
      next.delete(filePath)
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
    addComment,
    removeComment,
    clearComments,
  }), [openTabs, activeTabIndex, comments, isOpen, commentsEnabled, openFile, openFolder, toggleFolder, setFolderQuery, selectFolderEntry, renameFilePath, removeFilePath, renameDirectoryPath, removeDirectoryPath, closeTab, setActiveTab, setPdfPage, close, addComment, removeComment, clearComments])

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
