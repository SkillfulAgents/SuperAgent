import { useMemo, useState } from 'react'
import { AtSign } from 'lucide-react'
import { MessageInput } from '@renderer/components/messages/message-input'
import { describeVoiceInputRequest } from '@shared/lib/tools/registry'
import { useIsVoiceModeActive } from '@renderer/lib/voice-mode-handoff'
import { SessionThread } from '@renderer/components/messages/session-thread'
import { PendingRequestStack } from '@shared/lib/tools/requests/pending-request-stack'
import { renderPendingRequest, type RenderContext } from '@shared/lib/tools/requests/pending-request-renderer'
import { PendingRequestErrorBoundary } from '@shared/lib/tools/requests/pending-request-error-boundary'
import { usePendingRequests } from '@shared/lib/tools/requests/use-pending-requests'
import { StaleSessionNotice } from '@renderer/components/messages/stale-session-notice'
import { PendingWakeBanner } from '@renderer/components/messages/pending-wake-banner'
import { ProviderErrorPlacement } from '@renderer/components/provider-error/provider-error-placement'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useScreenWakeLock } from '@renderer/hooks/use-screen-wake-lock'
import { useStaleSession } from '@renderer/hooks/use-stale-session'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { DonutChart } from '@renderer/components/ui/donut-chart'
import type { RuntimeOptions } from '@shared/lib/container/runtime-options'
import type { PendingMessage } from '@renderer/components/messages/pending-message'
import type { PendingMessagesContextValue } from '@renderer/context/pending-messages-context'
import type { SessionUsage } from '@shared/lib/types/agent'
import type { MessageTarget } from '@renderer/components/messages/locate-message'

interface SessionChatColumnProps {
  sessionId: string | null
  onSessionCreated?: PendingMessagesContextValue['onSessionCreated']
  /** Route slug used by session APIs and navigation. */
  agentSlug: string
  /** Stable agent ID used by agent-scoped draft storage. */
  agentId?: string
  pendingUserMessages: PendingMessage[]
  isViewOnly: boolean
  contextPercent: number | null
  /** The runtime options last used on this session; they seed the composer. */
  runtimeOptions?: RuntimeOptions
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
  pendingWakeSummary?: string
  messageTarget?: MessageTarget
}

export function SessionChatColumn({
  sessionId,
  onSessionCreated,
  agentSlug,
  agentId,
  pendingUserMessages,
  isViewOnly,
  contextPercent,
  runtimeOptions,
  onPendingMessageAppeared,
  onMessageSent,
  onMessageUuidAssigned,
  onMessageFailed,
  lastActivityAt,
  contextUsage,
  pendingWakeAt,
  pendingWakeTaskId,
  pendingWakeNote,
  pendingWakeSummary,
  messageTarget,
}: SessionChatColumnProps) {
  const { isActive, browserActive, isWaitingBackground } = useMessageStream(sessionId, agentSlug, ['isActive', 'browserActive', 'isWaitingBackground'])
  const voiceModeActive = useIsVoiceModeActive(sessionId)
  // Who the composer's message only notifies, said in place of the key hints.
  const [notifiesOnly, setNotifiesOnly] = useState<string | null>(null)
  // Keep the phone awake (PWA only) while this session is actively working.
  useScreenWakeLock(isActive || isWaitingBackground)
  const { items: pendingRequestItems, count: pendingRequestCount } = usePendingRequests({
    sessionId,
    agentSlug,
    pendingUserMessages,
  })
  const voiceInputRequests = useMemo(() => pendingRequestItems.map(describeVoiceInputRequest), [pendingRequestItems])

  const renderCtx: RenderContext | null = sessionId ? { sessionId, agentSlug, readOnly: isViewOnly } : null

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
      suppressScrollToBottom={staleSession.popoverOpen}
      messageTarget={messageTarget}
      overlayFooter
      footerClassName="max-w-[740px] mx-auto w-full"
      footer={
        <>
          {sessionId && renderCtx && pendingRequestCount > 0 && (
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
          )}
          {/* Kept mounted behind a request card or a blocking provider error, just
              hidden: what it holds (a draft, voice mode) survives. Voice mode pauses
              for either and picks the agent's turn back up once it is gone. */}
          <div hidden={pendingRequestCount > 0}>
            <ProviderErrorPlacement placement="composer" sessionId={sessionId} agentSlug={agentSlug}>
              {({ displaced }) => (
                <>
                  {sessionId && pendingWakeAt && pendingWakeTaskId && !isActive && (
                    <PendingWakeBanner
                      sessionId={sessionId}
                      agentSlug={agentSlug}
                      wakeAt={pendingWakeAt}
                      taskId={pendingWakeTaskId}
                      note={pendingWakeNote}
                      summary={pendingWakeSummary}
                      readOnly={isViewOnly}
                    />
                  )}
                  {staleSession.showNotice && (
                    <StaleSessionNotice
                      onIgnore={staleSession.ignore}
                      onContinueCompacted={staleSession.continueCompacted}
                      onStartFresh={staleSession.startFresh}
                      isPending={staleSession.isPending}
                      onPopoverOpenChange={staleSession.setPopoverOpen}
                    />
                  )}
                  {!isViewOnly && <MessageInput
                    onSessionCreated={onSessionCreated}
                    sessionId={sessionId}
                    agentSlug={agentSlug}
                    onMessageSent={onMessageSent}
                    onMessageUuidAssigned={onMessageUuidAssigned}
                    onMessageFailed={onMessageFailed}
                    initialRuntimeOptions={runtimeOptions}
                    registerSnapshot={staleSession.registerSnapshot}
                    suspended={pendingRequestCount > 0 || displaced}
                    inputRequests={voiceInputRequests}
                    onNotifiesOnlyChange={setNotifiesOnly}
                  />}
                  <SessionComposerHints contextPercent={contextPercent} isActive={isActive} voiceModeActive={voiceModeActive} notifiesOnly={isViewOnly ? null : notifiesOnly} />
                </>
              )}
            </ProviderErrorPlacement>
          </div>
        </>
      }
    />
  )
}

// The fade behind each end of the hints row, as one plain gradient. Transcript
// text scrolls under this row on every streamed token and scroll frame, so the
// panels carry no backdrop-filter and no mask: either one is a surface the
// compositor redoes each time what is behind it changes. The stops are the
// opacity the old pair made together (a background -> 75% -> transparent
// gradient under a mask that faded out from 55%), sampled every tenth.
const HINT_FADE_STOPS = [
  [1, 0], [0.75, 50], [0.675, 55], [0.533, 60], [0.3, 70], [0.133, 80], [0.033, 90], [0, 100],
].map(([alpha, at]) => `hsl(var(--background) / ${alpha}) ${at}%`).join(', ')

function SessionComposerHints({ contextPercent, isActive = false, voiceModeActive = false, notifiesOnly = null }: {
  contextPercent: number | null
  isActive?: boolean
  voiceModeActive?: boolean
  /** The message only notifies this teammate: said instead of the context usage. */
  notifiesOnly?: string | null
}) {
  return (
    <div className="relative isolate flex flex-wrap items-center justify-between gap-x-1.5 gap-y-0.5 overflow-hidden px-6 py-3">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 z-0 w-[52%]"
        style={{ backgroundImage: `linear-gradient(to right, ${HINT_FADE_STOPS})` }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 z-0 w-[52%]"
        style={{ backgroundImage: `linear-gradient(to left, ${HINT_FADE_STOPS})` }}
      />
      {/* Left: who a notify-only message reaches, in place of the context usage. */}
      {notifiesOnly ? (
        <span className="relative z-10 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="mention-notify-only-hint">
          <AtSign className="h-3 w-3 shrink-0 text-violet-500" aria-hidden />
          <span className="truncate" title={`Only notifies ${notifiesOnly}`}>Message ignored by agent</span>
        </span>
      ) : contextPercent != null ? (
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="relative z-10 flex cursor-default items-center gap-1.5 whitespace-nowrap">
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
      {voiceModeActive ? (
        <span className="relative z-10 flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground" data-testid="voice-mode-hint">
          <span>Speak or</span>
          <kbd className="inline-flex items-center justify-center rounded-sm bg-muted border border-border/50 px-1 h-4 text-xs font-sans leading-none">Space</kbd>
          <span>to Interrupt</span>
        </span>
      ) : (
        <span className="relative z-10 flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
          <kbd className="inline-flex items-center justify-center rounded-sm bg-muted border border-border/50 px-1 h-4 text-xs font-sans leading-none">↵</kbd>
          <span>Send</span>
          <span className="mx-1">·</span>
          <kbd className="inline-flex items-center justify-center rounded-sm bg-muted border border-border/50 px-1 h-4 text-xs font-sans leading-none">⇧↵</kbd>
          <span>New line</span>
        </span>
      )}
    </div>
  )
}
