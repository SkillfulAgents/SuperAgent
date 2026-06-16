import { Outlet, useParams } from '@tanstack/react-router'
import { useCallback, useRef, useState } from 'react'
import { useSelection } from '@renderer/context/selection-context'
import { useUser } from '@renderer/context/user-context'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { PendingMessagesProvider, type PendingMessagesContextValue } from '@renderer/context/pending-messages-context'
import type { PendingMessage } from '@renderer/components/messages/pending-message'

// Stable empty array so a session without pending messages doesn't re-render consumers.
const EMPTY_PENDING_MESSAGES: PendingMessage[] = []

/**
 * The `/agents/$slug` layout route. Mount-survival anchor #2 (migration plan
 * §8.1/§8.2): it stays mounted across the agent's sub-views, so it owns the
 * optimistic `pendingMessagesRef` and `useMessageStream` (holder #1), exposing
 * them to the agent body via PendingMessagesContext, and renders `<Outlet/>`.
 *
 * The agent slug comes from the route (URL-authoritative). The active sessionId
 * still comes from SelectionContext in R4 (sub-views are Selection-driven until
 * they become routes in R5–R10); this read flips to `useParams` at R9.
 */
export function AgentShell() {
  const params = useParams({ strict: false }) as { slug?: string }
  const slug = params.slug ?? null

  const { view, setView } = useSelection()
  const activeSessionId = view.kind === 'session' ? view.id : null

  const { user, isAuthMode } = useUser()
  const pendingMessagesRef = useRef(new Map<string, PendingMessage[]>())
  const [, forceUpdate] = useState(0)

  const getPendingMessages = useCallback(
    (sessionId: string | null) =>
      sessionId ? (pendingMessagesRef.current.get(sessionId) ?? EMPTY_PENDING_MESSAGES) : EMPTY_PENDING_MESSAGES,
    [],
  )

  const onMessageSent = useCallback(
    (content: string, localId: string, queued: boolean) => {
      if (!activeSessionId) return
      const existing = pendingMessagesRef.current.get(activeSessionId) ?? []
      pendingMessagesRef.current.set(activeSessionId, [
        ...existing,
        {
          localId,
          text: content,
          sentAt: Date.now(),
          queued,
          sender: isAuthMode && user ? { id: user.id, name: user.name, email: user.email } : undefined,
        },
      ])
      forceUpdate((n) => n + 1)
    },
    [activeSessionId, isAuthMode, user],
  )

  // The POST response carries the server-assigned uuid and authoritative queued
  // decision — attach both to the optimistic entry so the uuid materializes a
  // non-queued copy by exact id match and the label/placement stay honest.
  const onMessageUuidAssigned = useCallback(
    (localId: string, uuid: string, queued: boolean) => {
      if (!activeSessionId) return
      const existing = pendingMessagesRef.current.get(activeSessionId)
      if (!existing?.some((m) => m.localId === localId)) return
      pendingMessagesRef.current.set(
        activeSessionId,
        existing.map((m) => (m.localId === localId ? { ...m, uuid, queued } : m)),
      )
      forceUpdate((n) => n + 1)
    },
    [activeSessionId],
  )

  const onPendingMessageAppeared = useCallback(
    (localId: string) => {
      if (!activeSessionId) return
      const existing = pendingMessagesRef.current.get(activeSessionId)
      if (!existing?.some((m) => m.localId === localId)) return
      const remaining = existing.filter((m) => m.localId !== localId)
      if (remaining.length > 0) {
        pendingMessagesRef.current.set(activeSessionId, remaining)
      } else {
        pendingMessagesRef.current.delete(activeSessionId)
      }
      forceUpdate((n) => n + 1)
    },
    [activeSessionId],
  )

  // New session created with an initial message: the uuid is server-assigned
  // (from the create response), so it's known up-front — no re-keying needed.
  const onSessionCreated = useCallback(
    (newSessionId: string, initialMessage: string, messageUuid: string) => {
      pendingMessagesRef.current.set(newSessionId, [
        {
          localId: messageUuid,
          uuid: messageUuid,
          text: initialMessage,
          sentAt: Date.now(),
          sender: isAuthMode && user ? { id: user.id, name: user.name, email: user.email } : undefined,
        },
      ])
      setView({ kind: 'session', id: newSessionId })
    },
    [setView, isAuthMode, user],
  )

  // Orphan cleanup: drop a deleted session's optimistic entry (migration plan §8.3).
  const clearPendingMessagesForSession = useCallback((sessionId: string) => {
    if (pendingMessagesRef.current.delete(sessionId)) forceUpdate((n) => n + 1)
  }, [])

  // Holder #1 of the two-holder EventSource pattern: keeps the stream ref-counted
  // open across leaf changes (SessionChatColumn is holder #2).
  const { contextUsage: streamContextUsage } = useMessageStream(activeSessionId, slug)

  const value: PendingMessagesContextValue = {
    getPendingMessages,
    onMessageSent,
    onMessageUuidAssigned,
    onPendingMessageAppeared,
    onSessionCreated,
    clearPendingMessagesForSession,
    streamContextUsage,
  }

  return (
    <PendingMessagesProvider value={value}>
      <Outlet />
    </PendingMessagesProvider>
  )
}
