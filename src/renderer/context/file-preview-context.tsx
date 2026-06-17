import { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { useSelection } from './selection-context'

export interface FileTab {
  filePath: string
  agentSlug: string
  displayName: string
  description?: string
  version: number
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
}

interface FilePreviewContextType {
  openFiles: FileTab[]
  activeFileIndex: number
  comments: Map<string, FileComment[]>
  isOpen: boolean

  openFile: (filePath: string, agentSlug: string, description?: string) => void
  closeFile: (filePath: string) => void
  setActiveFile: (index: number) => void
  close: () => void

  addComment: (comment: Omit<FileComment, 'id'>) => void
  removeComment: (filePath: string, commentId: string) => void
  clearComments: (filePath: string) => void
}

const FilePreviewContext = createContext<FilePreviewContextType | null>(null)

function getDisplayName(filePath: string): string {
  return filePath.split('/').pop() || filePath
}

let commentIdCounter = 0

export function FilePreviewProvider({ children, sessionId: sessionIdProp }: { children: ReactNode; sessionId?: string | null }) {
  const { view } = useSelection()
  // Views that own a session (e.g. chat integrations) can pass it explicitly so
  // state clears when switching sessions; otherwise derive from the active selection.
  const sessionId = sessionIdProp !== undefined ? sessionIdProp : (view.kind === 'session' ? view.id : null)

  const [openFiles, setOpenFiles] = useState<FileTab[]>([])
  const [activeFileIndex, setActiveFileIndex] = useState(0)
  const [comments, setComments] = useState<Map<string, FileComment[]>>(new Map())
  const [isOpen, setIsOpen] = useState(false)

  // Clear state when session changes
  useEffect(() => {
    setOpenFiles([])
    setActiveFileIndex(0)
    setComments(new Map())
    setIsOpen(false)
  }, [sessionId])

  const openFile = useCallback((filePath: string, agentSlug: string, description?: string) => {
    setOpenFiles(prev => {
      const existingIndex = prev.findIndex(f => f.filePath === filePath)
      if (existingIndex >= 0) {
        setActiveFileIndex(existingIndex)
        setIsOpen(true)
        const next = [...prev]
        next[existingIndex] = { ...next[existingIndex], version: next[existingIndex].version + 1 }
        return next
      }
      const newTab: FileTab = { filePath, agentSlug, displayName: getDisplayName(filePath), description, version: 0 }
      const next = [...prev, newTab]
      setActiveFileIndex(next.length - 1)
      setIsOpen(true)
      return next
    })
  }, [])

  const closeFile = useCallback((filePath: string) => {
    setOpenFiles(prev => {
      const idx = prev.findIndex(f => f.filePath === filePath)
      if (idx < 0) return prev
      const next = prev.filter((_, i) => i !== idx)
      if (next.length === 0) {
        setIsOpen(false)
        setActiveFileIndex(0)
      } else {
        setActiveFileIndex(curr => {
          if (curr >= next.length) return next.length - 1
          if (curr > idx) return curr - 1
          return curr
        })
      }
      return next
    })
    setComments(prev => {
      const next = new Map(prev)
      next.delete(filePath)
      return next
    })
  }, [])

  const setActiveFile = useCallback((index: number) => {
    setActiveFileIndex(index)
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
  }, [])

  const addComment = useCallback((comment: Omit<FileComment, 'id'>) => {
    const id = `comment-${++commentIdCounter}`
    setComments(prev => {
      const next = new Map(prev)
      const existing = next.get(comment.filePath) || []
      next.set(comment.filePath, [...existing, { ...comment, id }])
      return next
    })
  }, [])

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
    openFiles,
    activeFileIndex,
    comments,
    isOpen,
    openFile,
    closeFile,
    setActiveFile,
    close,
    addComment,
    removeComment,
    clearComments,
  }), [openFiles, activeFileIndex, comments, isOpen, openFile, closeFile, setActiveFile, close, addComment, removeComment, clearComments])

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
