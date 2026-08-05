import { MessageInput } from '@renderer/components/messages/message-input'
import { SessionThread } from '@renderer/components/messages/session-thread'
import { PendingRequestStack } from '@renderer/components/messages/pending-request-stack'
import { renderPendingRequest, type RenderContext } from '@renderer/components/messages/pending-request-renderer'
import { PendingRequestErrorBoundary } from '@renderer/components/messages/pending-request-error-boundary'
import { usePendingRequests } from '@renderer/components/messages/use-pending-requests'
import { StaleSessionNotice } from '@renderer/components/messages/stale-session-notice'
import { PendingWakeBanner } from '@renderer/components/messages/pending-wake-banner'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useScreenWakeLock } from '@renderer/hooks/use-screen-wake-lock'
import { useFileDeliveryWatcher } from '@renderer/hooks/use-file-delivery-watcher'
import { useStaleSession } from '@renderer/hooks/use-stale-session'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { DonutChart } from '@renderer/components/ui/donut-chart'
import type { EffortLevel, SpeedLevel } from '@shared/lib/container/types'
import type { PendingMessage } from '@renderer/components/messages/pending-message'
import type { SessionUsage } from '@shared/lib/types/agent'

interface SessionChatColumnProps {
  sessionId: string
  /** Route slug used by session APIs and navigation. */
  agentSlug: string
  /** Stable agent ID used by agent-scoped draft storage. */
  agentId?: string
  pendingUserMessages: PendingMessage[]
  isViewOnly: boolean
  contextPercent: number | null
  effort?: EffortLevel
  speed?: SpeedLevel
  model?: string
  onPendingMessageAppeared: (localId: string) => void
  onMessageSent: (content: string, localId: string, queued: boolean) => void
  onMessageUuidAssigned: (localId: string, uuid: string, queued: boolean) => void
  onMessageFailed: (localId: string) => void
  lastActivityAt?: Date | null
  contextUsage?: SessionUsage | null
  // Pending scheduled wake (long sleep) — renders the auto-resume banner
  pendingWakeAt?: string
  pendingWakeTaskId?: string
  pendingWakeNote?: string
}

export function SessionChatColumn({
  sessionId,
  agentSlug,
  agentId,
  pendingUserMessages,
  isViewOnly,
  contextPercent,
  effort,
  speed,
  model,
  onPendingMessageAppeared,
  onMessageSent,
  onMessageUuidAssigned,
  onMessageFailed,
  lastActivityAt,
  contextUsage,
  pendingWakeAt,
  pendingWakeTaskId,
  pendingWakeNote,
}: SessionChatColumnProps) {
  const { isActive, browserActive, isWaitingBackground } = useMessageStream(sessionId, agentSlug)
  // Keep the phone awake (PWA only) while this session is actively working.
  useScreenWakeLock(isActive || isWaitingBackground)
  useFileDeliveryWatcher(sessionId, agentSlug)
  const { items: pendingRequestItems, count: pendingRequestCount } = usePendingRequests({
    sessionId,
    agentSlug,
    pendingUserMessages,
  })

  const renderCtx: RenderContext = { sessionId, agentSlug, readOnly: isViewOnly }

  const staleSession = useStaleSession({
    sessionId,
    agentSlug: agentId ?? agentSlug,
    routeAgentSlug: agentSlug,
    isActive,
    isWaitingBackground,
    isAwaitingInput: pendingRequestCount > 0,
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
      suppressScrollToBottom={staleSession.learnMoreOpen}
      overlayFooter
      footerClassName="max-w-[740px] mx-auto w-full"
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
            {pendingWakeAt && pendingWakeTaskId && !isActive && (
              <PendingWakeBanner
                sessionId={sessionId}
                agentSlug={agentSlug}
                wakeAt={pendingWakeAt}
                taskId={pendingWakeTaskId}
                note={pendingWakeNote}
                readOnly={isViewOnly}
              />
            )}
            {staleSession.showNotice && (
              <StaleSessionNotice
                onIgnore={staleSession.ignore}
                onStartFresh={staleSession.startFresh}
                onLearnMoreOpenChange={staleSession.setLearnMoreOpen}
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
              initialSpeed={speed}
              initialModel={model}
              registerSnapshot={staleSession.registerSnapshot}
            />
            <div className="relative isolate flex items-center justify-between gap-1.5 overflow-hidden px-6 py-3">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-0 z-0 w-[52%] bg-gradient-to-r from-background via-background/75 to-transparent backdrop-blur-[2px]"
                style={{
                  maskImage: 'linear-gradient(to right, black 0%, black 55%, transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to right, black 0%, black 55%, transparent 100%)',
                }}
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 right-0 z-0 w-[52%] bg-gradient-to-l from-background via-background/75 to-transparent backdrop-blur-[2px]"
                style={{
                  maskImage: 'linear-gradient(to left, black 0%, black 55%, transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to left, black 0%, black 55%, transparent 100%)',
                }}
              />
              {contextPercent != null ? (
                <TooltipProvider delayDuration={0}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="relative z-10 flex cursor-default items-center gap-1.5">
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
                <span className="relative z-10" />
              )}
              <span className="relative z-10 flex items-center gap-1 text-xs text-muted-foreground">
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
