import { Outlet, useParams, useNavigate } from '@tanstack/react-router'
import { useCallback, useRef, useState } from 'react'
import { useUser } from '@renderer/context/user-context'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useStartAgent, useStopAgent } from '@renderer/hooks/use-agents'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { ErrorBoundary } from '@renderer/components/ui/error-boundary'
import { PendingMessagesProvider, type PendingMessagesContextValue } from '@renderer/context/pending-messages-context'
import type { PendingMessage } from '@renderer/components/messages/pending-message'
import { ContentShell } from './content-shell'
import { AgentHeader } from './agent-header'
import { AgentBanners } from './agent-banners'

// Stable empty array so a session without pending messages doesn't re-render consumers.
const EMPTY_PENDING_MESSAGES: PendingMessage[] = []

/**
 * The `/agents/$slug` layout route. It stays mounted across the agent's
 * sub-views, so it owns the optimistic `pendingMessagesRef` and
 * `useMessageStream` (holder #1), exposing them to the agent body via
 * PendingMessagesContext.
 *
 * It is also the shared layout — it owns the agent header chrome (`AgentHeader`)
 * and agent-level banners (`AgentBanners`) above a single `<Outlet/>`, so every
 * sub-view (the agent body index, plus the api-logs/connections leaf routes)
 * inherits one mounted header instead of re-rendering its own.
 *
 * The agent slug AND the active sessionId both come from the route:
 * `useParams({ strict: false })` returns the deepest match's params, so on the
 * session leaf it surfaces the child `sessionId` to this parent layout, driving
 * holder #1 of the two-holder EventSource directly off the URL.
 */
export function AgentShell() {
  const params = useParams({ strict: false }) as { slug?: string; sessionId?: string }
  const slug = params.slug ?? null
  const activeSessionId = params.sessionId ?? null

  const navigate = useNavigate()

  const { user, isAuthMode, canUseAgent } = useUser()
  const isViewOnly = slug ? !canUseAgent(slug) : false
  const startAgent = useStartAgent()
  const stopAgent = useStopAgent()
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()
  const needsTrafficLightPadding =
    isElectron() && getPlatform() === 'darwin' && sidebarState === 'collapsed' && !isFullScreen
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
  // Seed the optimistic ghost into the ref (which lives here, so it survives the
  // index→session-leaf swap), then navigate to the session route. AgentShell
  // stays mounted across that navigation, so the ghost is intact when the leaf
  // reads it via getPendingMessages.
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
      if (slug) {
        void navigate({
          to: '/agents/$slug/sessions/$sessionId',
          params: { slug, sessionId: newSessionId },
        })
      }
    },
    [navigate, slug, isAuthMode, user],
  )

  // Orphan cleanup: drop a deleted session's optimistic entry.
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
      <ContentShell
        needsTrafficLightPadding={needsTrafficLightPadding}
        headerContent={
          slug ? (
            <AgentHeader slug={slug} isViewOnly={isViewOnly} startAgent={startAgent} stopAgent={stopAgent} />
          ) : null
        }
      >
        {slug && <AgentBanners slug={slug} startAgent={startAgent} />}
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </ContentShell>
    </PendingMessagesProvider>
  )
}
