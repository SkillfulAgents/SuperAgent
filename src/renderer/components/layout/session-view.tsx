import { SessionChatColumn } from './session-chat-column'
import { FilePreviewProvider } from '@renderer/context/file-preview-context'
import { ChevronLeft, CalendarClock, Zap } from 'lucide-react'
import { useEffect } from 'react'
import { useSession } from '@renderer/hooks/use-sessions'
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
 * `FilePreviewProvider` wraps ONLY this leaf (migration plan §8.4): files are
 * session-specific, so it must remount/clear when the route's `sessionId`
 * changes. The optimistic `pendingMessagesRef` + two-holder `useMessageStream`
 * live one level up in `AgentShell`, so they survive leaving this leaf for a
 * sibling sub-view and coming back.
 */
export function SessionView({ agentSlug, sessionId }: SessionViewProps) {
  useRenderTracker('SessionView')
  const navigate = useNavigate()
  const { data: session } = useSession(sessionId, agentSlug)
  const markSessionNotificationsRead = useMarkSessionNotificationsRead()
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
    // Small delay to avoid marking as read on quick navigation
    const timeout = setTimeout(() => {
      markSessionNotificationsRead.mutate(sessionId)
    }, 1000)
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

  return (
    <>
      {/* Automated session indicator — links back to the parent trigger/schedule */}
      {session?.scheduledTaskId && (
        <div className="shrink-0 border-b bg-background px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <button
              onClick={() => {
                const taskId = session.scheduledTaskId!
                void navigate({ to: '/agents/$slug/tasks/$taskId', params: { slug: agentSlug, taskId } })
              }}
              className="inline-flex items-center gap-1 text-primary hover:underline shrink-0"
            >
              <ChevronLeft className="h-3 w-3" />
              View schedule
            </button>
            <span className="mx-1 text-border">|</span>
            <CalendarClock className="h-3 w-3 shrink-0" />
            <span>
              Session created by scheduled job{session.scheduledTaskName ? ` "${session.scheduledTaskName}"` : ''}
            </span>
          </div>
        </div>
      )}
      {session?.webhookTriggerId && (
        <div className="shrink-0 border-b bg-background px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <button
              onClick={() => {
                const webhookId = session.webhookTriggerId!
                void navigate({ to: '/agents/$slug/webhooks/$webhookId', params: { slug: agentSlug, webhookId } })
              }}
              className="inline-flex items-center gap-1 text-primary hover:underline shrink-0"
            >
              <ChevronLeft className="h-3 w-3" />
              View trigger
            </button>
            <span className="mx-1 text-border">|</span>
            <Zap className="h-3 w-3 shrink-0" />
            <span>
              Session created by webhook trigger{session.webhookTriggerName ? ` "${session.webhookTriggerName}"` : ''}
            </span>
          </div>
        </div>
      )}

      <FilePreviewProvider>
        <div className="flex-1 flex flex-col min-h-0">
          <SessionSearchBar search={search} />
          <SessionChatColumn
            sessionId={sessionId}
            agentSlug={agentSlug}
            pendingUserMessages={getPendingMessages(sessionId)}
            isViewOnly={isViewOnly}
            contextPercent={contextPercent}
            effort={session?.effort}
            model={session?.model}
            onPendingMessageAppeared={onPendingMessageAppeared}
            onMessageSent={onMessageSent}
            onMessageUuidAssigned={onMessageUuidAssigned}
            onMessageFailed={onPendingMessageAppeared}
          />
        </div>
      </FilePreviewProvider>
    </>
  )
}

if (__RENDER_TRACKING__) {
  (SessionView as any).whyDidYouRender = true
}
