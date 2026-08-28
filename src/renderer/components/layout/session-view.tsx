import { SessionChatColumn } from './session-chat-column'
import { FilePreviewProvider } from '@renderer/context/file-preview-context'
import { WorkflowProvider } from '@renderer/context/workflow-context'
import { CalendarClock, GitFork, Split, Zap } from 'lucide-react'
import { SessionProvenanceBanner } from './session-provenance-banner'
import { useEffect } from 'react'
import { useSession, useSetSessionMarkedUnread, useClearSessionUnread } from '@renderer/hooks/use-sessions'
import { HttpError } from '@renderer/lib/api'
import { SessionNotFound } from '@renderer/router/route-fallbacks'
import { useNavigate } from '@tanstack/react-router'
import { useMarkSessionNotificationsRead } from '@renderer/hooks/use-notifications'
import { usePendingMessages } from '@renderer/context/pending-messages-context'
import { useUser } from '@renderer/context/user-context'
import { useRenderTracker } from '@renderer/lib/perf'
import { computeContextPercent } from '@shared/lib/utils/context-usage'
import { useSessionSearch } from '@renderer/hooks/use-session-search'
import { SessionSearchBar } from '@renderer/components/messages/session-search-bar'

interface SessionViewProps {
  agentSlug: string
  sessionId: string
}

/**
 * The session leaf (sessionRoute, `/agents/$slug/sessions/$sessionId`). Renders
 * the chat column, the per-session search bar, and the automated-session
 * indicator banners (which link back to the originating trigger/schedule).
 *
 * `FilePreviewProvider` wraps ONLY this leaf: files are session-specific, so it
 * must remount/clear when the route's `sessionId` changes. The optimistic
 * `pendingMessagesRef` + two-holder `useMessageStream` live one level up in
 * `AgentShell`, so they survive leaving this leaf for a sibling sub-view and
 * coming back.
 */
export function SessionView({ agentSlug, sessionId }: SessionViewProps) {
  useRenderTracker('SessionView')
  const navigate = useNavigate()
  const { data: session, error: sessionError } = useSession(sessionId, agentSlug)
  const markSessionNotificationsRead = useMarkSessionNotificationsRead()
  const setSessionMarkedUnread = useSetSessionMarkedUnread()
  const clearSessionUnread = useClearSessionUnread()
  const {
    getPendingMessages,
    onMessageSent,
    onMessageUuidAssigned,
    onPendingMessageAppeared,
    streamContextUsage,
  } = usePendingMessages()
  const { canUseAgent } = useUser()
  const isViewOnly = !canUseAgent(agentSlug)
  const search = useSessionSearch(true, sessionId)

  // Context usage: prefer live stream data, fall back to persisted session metadata
  const contextUsage = streamContextUsage ?? session?.lastUsage ?? null
  const contextPercent = contextUsage ? computeContextPercent(contextUsage) : null

  // Auto-mark notifications as read when viewing a session
  useEffect(() => {
    const clearWrites = () => {
      markSessionNotificationsRead.mutate(sessionId)
      // "Mark as unread" survives until the session is *reopened*, so it clears
      // here and deliberately not in the visibilitychange handler below —
      // otherwise marking the session you're looking at would be undone by the
      // next window refocus.
      setSessionMarkedUnread.mutate({ sessionId, agentSlug, markedUnread: false })
    }
    // Take the dot down in the caches right away — waiting for the write plus
    // the session-list refetch is what made clicking a dotted session feel like
    // it lagged. A session that was actually dotted also writes immediately
    // rather than on the debounce below: the optimistic state has to match what
    // the server will report, or the next refetch puts the dot back.
    if (clearSessionUnread(agentSlug, sessionId)) {
      clearWrites()
      return
    }
    // Nothing was showing, so the writes are a no-op for the dot — keep them on
    // a small delay to avoid marking as read on quick navigation.
    const timeout = setTimeout(clearWrites, 1000)
    return () => clearTimeout(timeout)
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Also mark notifications as read when the tab regains focus while viewing it
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        markSessionNotificationsRead.mutate(sessionId)
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // A genuine 404 (deep-link to a non-existent / deleted session) → ambiguous
  // not-found. The pending-messages guard means a just-created session
  // (optimistic ghost in flight while the backend catches up) never flashes
  // not-found — and the agent-level loader has already gated access.
  if (
    sessionError instanceof HttpError &&
    sessionError.status === 404 &&
    getPendingMessages(sessionId).length === 0
  ) {
    return <SessionNotFound agentSlug={agentSlug} />
  }

  return (
    <>
      {session?.scheduledTaskId && (
        <SessionProvenanceBanner
          icon={CalendarClock}
          text={<>Session created by scheduled job{session.scheduledTaskName ? ` "${session.scheduledTaskName}"` : ''}</>}
          back={{
            label: 'View schedule',
            onClick: () => {
              const taskId = session.scheduledTaskId!
              void navigate({ to: '/agents/$slug/tasks/$taskId', params: { slug: agentSlug, taskId } })
            },
          }}
        />
      )}
      {session?.webhookTriggerId && (
        <SessionProvenanceBanner
          icon={Zap}
          text={<>Session created by webhook trigger{session.webhookTriggerName ? ` "${session.webhookTriggerName}"` : ''}</>}
          back={{
            label: 'View trigger',
            onClick: () => {
              const webhookId = session.webhookTriggerId!
              void navigate({ to: '/agents/$slug/webhooks/$webhookId', params: { slug: agentSlug, webhookId } })
            },
          }}
        />
      )}
      {session?.invokedByAgentSlug && (
        <SessionProvenanceBanner
          icon={GitFork}
          text={<>Session created by x-agent call from &quot;{session.invokedByAgentName ?? session.invokedByAgentSlug}&quot;</>}
          back={{
            label: 'Back',
            onClick: () => {
              void navigate({ to: '/agents/$slug/called-from-agents', params: { slug: agentSlug } })
            },
            testId: 'x-agent-session-back-button',
          }}
          testId="x-agent-session-banner"
        />
      )}
      {session?.forkedFromSessionId && (
        <SessionProvenanceBanner
          icon={Split}
          text={
            session.forkedFromSessionName
              ? <>Forked from &quot;{session.forkedFromSessionName}&quot;</>
              : <>Forked from a deleted session</>
          }
          back={
            session.forkedFromSessionName
              ? {
                  label: 'Back',
                  onClick: () => {
                    const sourceId = session.forkedFromSessionId!
                    void navigate({ to: '/agents/$slug/sessions/$sessionId', params: { slug: agentSlug, sessionId: sourceId } })
                  },
                  testId: 'fork-session-back-button',
                }
              : undefined
          }
          testId="fork-session-banner"
        />
      )}

      <FilePreviewProvider>
        <WorkflowProvider>
          <div className="flex-1 flex flex-col min-h-0">
            <SessionSearchBar search={search} />
            <SessionChatColumn
              sessionId={sessionId}
              agentSlug={agentSlug}
              agentId={session?.agentSlug}
              pendingUserMessages={getPendingMessages(sessionId)}
              isViewOnly={isViewOnly}
              contextPercent={contextPercent}
              effort={session?.effort}
              speed={session?.speed}
              model={session?.model}
              onPendingMessageAppeared={onPendingMessageAppeared}
              onMessageSent={onMessageSent}
              onMessageUuidAssigned={onMessageUuidAssigned}
              onMessageFailed={onPendingMessageAppeared}
              lastActivityAt={session?.lastActivityAt ? new Date(session.lastActivityAt) : null}
              contextUsage={contextUsage}
              pendingWakeAt={session?.pendingWakeAt}
              pendingWakeTaskId={session?.pendingWakeTaskId}
              pendingWakeNote={session?.pendingWakeNote}
            />
          </div>
        </WorkflowProvider>
      </FilePreviewProvider>
    </>
  )
}

if (__RENDER_TRACKING__) {
  (SessionView as any).whyDidYouRender = true
}
