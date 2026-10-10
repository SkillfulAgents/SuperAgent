import { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { getPathName } from '@shared/lib/utils/workspace-path'
import { useRouteLocation } from '@renderer/router/use-route-location'
import { useFilePreviewTabs, nextFileVersion, type PreviewFileTab, type PreviewFolderTab } from '@renderer/hooks/use-file-preview-tabs'
import type { CommentAnchor } from '@renderer/components/file-preview/comments/kinds'

export interface FileTab extends PreviewFileTab {
  agentSlug: string
}

export interface FolderTab extends PreviewFolderTab {
  agentSlug: string
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

/** The folder equivalent: two agents can have a browser open on the same root. */
function isFolderTabFor(tab: PreviewTab, agentSlug: string, rootPath: string): tab is FolderTab {
  return tab.kind === 'folder' && tab.agentSlug === agentSlug && tab.rootPath === rootPath
}

export interface FileComment {
  id: string
  filePath: string
  /** Which agent's copy of `filePath` this is feedback on. */
  agentSlug: string
  text: string
  anchor: CommentAnchor
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

  const {
    openTabs, setOpenTabs, activeTabIndex, setActiveTabIndex, openTab,
    closeTab: closePreviewTab, setPdfPage: setPreviewPdfPage,
  } = useFilePreviewTabs<PreviewTab>(getPreviewTabKey)
  // Keyed by getWorkspaceFileKey, not by path: see the note on that function.
  const [comments, setComments] = useState<Map<string, FileComment[]>>(new Map())
  const [isOpen, setIsOpen] = useState(false)

  // Clear state when session changes
  useEffect(() => {
    setOpenTabs([])
    setActiveTabIndex(0)
    setComments(new Map())
    setIsOpen(false)
  }, [sessionId, setOpenTabs, setActiveTabIndex])

  const openFile = useCallback((filePath: string, agentSlug: string, description?: string) => {
    const version = nextFileVersion()
    openTab({
      kind: 'file', filePath, agentSlug, displayName: getDisplayName(filePath),
      description, version, pdfPage: 1,
    }, existing => ({ ...existing, version }))
    setIsOpen(true)
  }, [openTab])

  const openFolder = useCallback((folderPath: string, agentSlug: string) => {
    const rootPath = normalizeFolderPath(folderPath)
    openTab({
      kind: 'folder', rootPath, agentSlug, displayName: getDisplayName(rootPath),
      expandedPaths: [rootPath], query: '',
    })
    setIsOpen(true)
  }, [openTab])

  const toggleFolder = useCallback((rootPath: string, agentSlug: string, folderPath: string) => {
    setOpenTabs(prev => prev.map(tab => {
      if (!isFolderTabFor(tab, agentSlug, rootPath) || folderPath === rootPath) return tab
      const expanded = new Set(tab.expandedPaths)
      if (expanded.has(folderPath)) expanded.delete(folderPath)
      else expanded.add(folderPath)
      return { ...tab, expandedPaths: Array.from(expanded) }
    }))
  }, [setOpenTabs])

  const setFolderQuery = useCallback((rootPath: string, agentSlug: string, query: string) => {
    setOpenTabs(prev => prev.map(tab => (
      isFolderTabFor(tab, agentSlug, rootPath) ? { ...tab, query } : tab
    )))
  }, [setOpenTabs])

  const selectFolderEntry = useCallback((rootPath: string, agentSlug: string, entryPath: string) => {
    setOpenTabs(prev => prev.map(tab => (
      isFolderTabFor(tab, agentSlug, rootPath) ? { ...tab, selectedPath: entryPath } : tab
    )))
  }, [setOpenTabs])

  const renameFilePath = useCallback((oldPath: string, newPath: string, agentSlug: string) => {
    const version = nextFileVersion()
    setOpenTabs(prev => prev.map(tab => {
      if (tab.kind === 'file' && tab.agentSlug === agentSlug && tab.filePath === oldPath) {
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
  }, [setOpenTabs])

  const closeTab = useCallback((tabKey: string) => {
    closePreviewTab(tabKey, (closed, remaining) => {
      if (closed.kind === 'file') {
        const commentKey = getWorkspaceFileKey(closed.agentSlug, closed.filePath)
        setComments(current => {
          if (!current.has(commentKey)) return current
          const next = new Map(current)
          next.delete(commentKey)
          return next
        })
      }
      if (remaining.length === 0) setIsOpen(false)
    })
  }, [closePreviewTab])

  const removeFilePath = useCallback((filePath: string, agentSlug: string) => {
    closeTab(`file:${getWorkspaceFileKey(agentSlug, filePath)}`)
    setOpenTabs(prev => prev.map(tab => (
      tab.kind === 'folder' && tab.agentSlug === agentSlug && tab.selectedPath === filePath
        ? { ...tab, selectedPath: undefined }
        : tab
    )))
  }, [closeTab, setOpenTabs])

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
  }, [setOpenTabs])

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
  }, [setOpenTabs, setActiveTabIndex])

  const setActiveTab = useCallback((index: number) => {
    setActiveTabIndex(index)
  }, [setActiveTabIndex])

  const setPdfPage = useCallback((filePath: string, agentSlug: string, page: number) => {
    setPreviewPdfPage(`file:${getWorkspaceFileKey(agentSlug, filePath)}`, page)
  }, [setPreviewPdfPage])

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
