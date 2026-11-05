import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ApiMessage } from '@shared/lib/types/api'

interface ThreadContextType {
  /** The message whose thread the drawer shows, or null. */
  parent: ApiMessage | null
  isOpen: boolean
  /** False for a viewer: they read threads but cannot reply. */
  canReply: boolean
  /** Bumped on every open, so opening the same thread again re-focuses the drawer. */
  openCount: number
  openThread: (parent: ApiMessage) => void
  close: () => void
}

const ThreadContext = createContext<ThreadContextType | null>(null)

/**
 * Which message's thread the side drawer shows, as Slack's thread pane does.
 * Mirrors WorkflowProvider: it only tracks the selection and clears when the
 * session changes; the replies are fetched from the host.
 */
export function ThreadProvider({ children, sessionId, canReply = true }: { children: ReactNode; sessionId: string | null; canReply?: boolean }) {
  const [parent, setParent] = useState<ApiMessage | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [openCount, setOpenCount] = useState(0)

  useEffect(() => {
    setParent(null)
    setIsOpen(false)
  }, [sessionId])

  const openThread = useCallback((message: ApiMessage) => {
    setParent(message)
    setIsOpen(true)
    setOpenCount((count) => count + 1)
  }, [])

  const close = useCallback(() => setIsOpen(false), [])

  const value = useMemo(() => ({ parent, isOpen, canReply, openCount, openThread, close }), [parent, isOpen, canReply, openCount, openThread, close])
  return <ThreadContext.Provider value={value}>{children}</ThreadContext.Provider>
}

/** Null outside a session view (Agent Home, read-only mirrors): those have no threads. */
export function useOptionalThread(): ThreadContextType | null {
  return useContext(ThreadContext)
}
