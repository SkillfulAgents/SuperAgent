import { MessageInput } from '@renderer/components/messages/message-input'
import { SessionThread } from '@renderer/components/messages/session-thread'
import { PendingRequestStack } from '@renderer/components/messages/pending-request-stack'
import { renderPendingRequest, type RenderContext } from '@renderer/components/messages/pending-request-renderer'
import { PendingRequestErrorBoundary } from '@renderer/components/messages/pending-request-error-boundary'
import { usePendingRequests } from '@renderer/components/messages/use-pending-requests'
import { StaleSessionToast } from '@renderer/components/messages/stale-session-notice'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useScreenWakeLock } from '@renderer/hooks/use-screen-wake-lock'
import { useFileDeliveryWatcher } from '@renderer/hooks/use-file-delivery-watcher'
import { useStaleSession } from '@renderer/hooks/use-stale-session'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { DonutChart } from '@renderer/components/ui/donut-chart'
import type { EffortLevel } from '@shared/lib/container/types'
import type { PendingMessage } from '@renderer/components/messages/pending-message'
import type { SessionUsage } from '@shared/lib/types/agent'

interface SessionChatColumnProps {
  sessionId: string
  agentSlug: string
  pendingUserMessages: PendingMessage[]
  isViewOnly: boolean
  contextPercent: number | null
  effort?: EffortLevel
  model?: string
  onPendingMessageAppeared: (localId: string) => void
  onMessageSent: (content: string, localId: string, queued: boolean) => void
  onMessageUuidAssigned: (localId: string, uuid: string, queued: boolean) => void
  onMessageFailed: (localId: string) => void
  lastActivityAt?: Date | null
  contextUsage?: SessionUsage | null
}

export function SessionChatColumn({
  sessionId,
  agentSlug,
  pendingUserMessages,
  isViewOnly,
  contextPercent,
  effort,
  model,
  onPendingMessageAppeared,
  onMessageSent,
  onMessageUuidAssigned,
  onMessageFailed,
  lastActivityAt,
  contextUsage,
}: SessionChatColumnProps) {
  const {
    isActive,
    browserActive,
    isWaitingBackground,
    pendingSecretRequests,
    pendingConnectedAccountRequests,
    pendingQuestionRequests,
    pendingFileRequests,
    pendingRemoteMcpRequests,
    pendingBrowserInputRequests,
  } = useMessageStream(sessionId, agentSlug)
  // Keep the phone awake (PWA only) while this session is actively working.
  useScreenWakeLock(isActive || isWaitingBackground)
  useFileDeliveryWatcher(sessionId, agentSlug)
  const { items: pendingRequestItems, count: pendingRequestCount } = usePendingRequests({
    sessionId,
    agentSlug,
    pendingUserMessages,
  })

  const renderCtx: RenderContext = { sessionId, agentSlug, readOnly: isViewOnly }

  const isAwaitingInput = isActive && (
    pendingSecretRequests.length > 0 ||
    pendingConnectedAccountRequests.length > 0 ||
    pendingQuestionRequests.length > 0 ||
    pendingFileRequests.length > 0 ||
    pendingRemoteMcpRequests.length > 0 ||
    pendingBrowserInputRequests.length > 0
  )

  // Continuous stale-session detection + "Start fresh" handoff, off the send path
  // (so sending is never interrupted). See useStaleSession.
  const stale = useStaleSession({
    sessionId,
    agentSlug,
    isActive,
    isWaitingBackground,
    isAwaitingInput,
    isViewOnly,
    lastActivityAt,
    contextUsage,
  })

  return (
    <SessionThread
      sessionId={sessionId}
      agentSlug={agentSlug}
      browserActive={browserActive}
      pendingUserMessages={pendingUserMessages}
      pendingRequestCount={pendingRequestCount}
      onPendingMessageAppeared={onPendingMessageAppeared}
      suppressScrollToBottom={stale.menuOpen}
      footerClassName="bg-background max-w-[740px] mx-auto w-full"
      footer={
        pendingRequestCount > 0 ? (
          <div className="px-4 pb-4" data-testid="pending-request-slot">
            <PendingRequestStack>
              {pendingRequestItems.map((d) => (
                <PendingRequestErrorBoundary
                  key={d.key}
                  sessionId={sessionId}
                  agentSlug={agentSlug}
                  onDismiss={d.onComplete}
                  itemId={d.key}
                  kind={d.kind}
                >
                  {renderPendingRequest(d, renderCtx)}
                </PendingRequestErrorBoundary>
              ))}
            </PendingRequestStack>
          </div>
        ) : (
          <>
            {stale.showToast && (
              <StaleSessionToast
                onIgnore={stale.ignore}
                onStartFresh={stale.startFresh}
                onMenuOpenChange={stale.setMenuOpen}
              />
            )}
            <MessageInput
              key={sessionId}
              sessionId={sessionId}
              agentSlug={agentSlug}
              onMessageSent={onMessageSent}
              onMessageUuidAssigned={onMessageUuidAssigned}
              onMessageFailed={onMessageFailed}
              initialEffort={effort}
              initialModel={model}
              registerSnapshot={stale.registerSnapshot}
            />
            <div className="flex justify-between items-center gap-1.5 px-6 py-3">
              {contextPercent != null ? (
                <TooltipProvider delayDuration={0}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center gap-1.5 cursor-default">
                        <span className="text-xs text-muted-foreground">Context Usage</span>
                        <DonutChart
                          percent={contextPercent}
                          animated={isActive}
                          size="sm"
                          showLabel={false}
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{contextPercent}%</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                <span />
              )}
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <kbd className="inline-flex items-center justify-center rounded-sm bg-muted border border-border/50 px-1 h-4 text-xs font-sans leading-none">↵</kbd>
                <span>Send</span>
                <span className="mx-1">·</span>
                <kbd className="inline-flex items-center justify-center rounded-sm bg-muted border border-border/50 px-1 h-4 text-xs font-sans leading-none">⇧↵</kbd>
                <span>New line</span>
              </span>
            </div>
          </>
        )
      }
    />
  )
}
