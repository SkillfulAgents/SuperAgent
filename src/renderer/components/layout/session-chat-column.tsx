import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageInput } from '@renderer/components/messages/message-input'
import { SessionThread } from '@renderer/components/messages/session-thread'
import { PendingRequestStack } from '@renderer/components/messages/pending-request-stack'
import { renderPendingRequest, type RenderContext } from '@renderer/components/messages/pending-request-renderer'
import { PendingRequestErrorBoundary } from '@renderer/components/messages/pending-request-error-boundary'
import { usePendingRequests } from '@renderer/components/messages/use-pending-requests'
import { StaleSessionToast } from '@renderer/components/messages/stale-session-notice'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useFileDeliveryWatcher } from '@renderer/hooks/use-file-delivery-watcher'
import { useBranchSession } from '@renderer/hooks/use-sessions'
import { useDraftsStore } from '@renderer/context/drafts-context'
import { splitSnapshotForHandoff, carryoverKey, type ComposerSnapshot } from '@renderer/lib/composer-carryover'
import { evaluateStalePrompt } from '@shared/lib/stale-session/stale-session-trigger'
import { currentContextTokens } from '@shared/lib/stale-session/message-cost'
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
  onSessionCreated?: (sessionId: string, initialMessage: string, messageUuid: string) => void
  /** Navigate to the agent's new-chat composer. "Start fresh" snapshots the
   *  current composer into the carry-over, then calls this to land the user there. */
  onStartFresh?: () => void
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
  onSessionCreated,
  onStartFresh,
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
  useFileDeliveryWatcher(sessionId, agentSlug)
  const { items: pendingRequestItems, count: pendingRequestCount } = usePendingRequests({
    sessionId,
    agentSlug,
    pendingUserMessages,
  })

  const renderCtx: RenderContext = { sessionId, agentSlug, readOnly: isViewOnly }

  // --- Stale-session detection (continuous, not send-gated) ---
  // Same predicate and suppressors as before; only the call site moved off the
  // composer submit path so sending is never interrupted.
  const isAwaitingInput = isActive && (
    pendingSecretRequests.length > 0 ||
    pendingConnectedAccountRequests.length > 0 ||
    pendingQuestionRequests.length > 0 ||
    pendingFileRequests.length > 0 ||
    pendingRemoteMcpRequests.length > 0 ||
    pendingBrowserInputRequests.length > 0
  )
  const isRunning = isActive && !isWaitingBackground

  // `lastActivityAt` comes from the session-detail query, which only refreshes on
  // metadata changes / remount — not when a turn completes. So after the user sends
  // and the agent replies, it still reads the pre-send time, and the prompt would
  // immediately re-trip the moment the session goes idle. Track the live active->idle
  // transition as a fresher activity signal (set while active and at the instant it
  // goes idle) so a just-finished turn resets the idle clock.
  const [liveActivityAt, setLiveActivityAt] = useState<number | null>(null)
  const wasActiveRef = useRef(isActive)
  useEffect(() => {
    if (isActive || wasActiveRef.current) setLiveActivityAt(Date.now())
    wasActiveRef.current = isActive
  }, [isActive])

  const shouldPrompt = useMemo(() => {
    const activityMs = Math.max(lastActivityAt?.getTime() ?? 0, liveActivityAt ?? 0)
    return evaluateStalePrompt({
      idleMs: activityMs ? Date.now() - activityMs : 0,
      contextTokens: currentContextTokens(contextUsage),
      isAwaitingInput,
      isRunning,
    }).shouldPrompt
  }, [lastActivityAt, liveActivityAt, contextUsage, isAwaitingInput, isRunning])

  // Local Ignore (no persistence) + in-flight action state for the popover.
  const [ignored, setIgnored] = useState(false)
  // True while either stale-session popover is open; suppresses the centered
  // scroll-to-bottom FAB it would otherwise overlap.
  const [staleMenuOpen, setStaleMenuOpen] = useState(false)
  const [isSummarizing, setIsSummarizing] = useState(false)
  const [staleError, setStaleError] = useState<string | null>(null)
  const actionActiveRef = useRef(false)
  // Getter for the in-session composer's live state, registered by MessageInput.
  // "Start fresh" reads it to carry text + files + model + effort into the new chat.
  const composerSnapshotRef = useRef<(() => ComposerSnapshot) | null>(null)
  const registerSnapshot = useCallback((getSnapshot: (() => ComposerSnapshot) | null) => {
    composerSnapshotRef.current = getSnapshot
  }, [])

  const draftStore = useDraftsStore()
  const draftKey = `session:${sessionId}`
  const branchSession = useBranchSession()

  // The toast owns the footer slot only at rest; once active, the activity
  // indicator (rendered by SessionThread) owns it instead. View-only users can't
  // branch, so they never see it. Ignore is a local hide; it can return on a
  // later qualifying mount, and a plain send clears it as the idle gate resets.
  const showToast = shouldPrompt && !isActive && !isViewOnly && !ignored

  // Both forward actions carry the current composer draft verbatim if one exists
  // (the branch endpoint tolerates a blank draft). Read it imperatively so the
  // column doesn't re-render on every keystroke.
  const handleContinueSummary = useCallback(async () => {
    actionActiveRef.current = true
    setStaleError(null)
    setIsSummarizing(true)
    const content = draftStore.get<string>(draftKey) ?? ''
    try {
      const res = await branchSession.mutateAsync({ agentSlug, fromSessionId: sessionId, message: content, model })
      if (!actionActiveRef.current) return
      draftStore.set(draftKey, undefined)
      onSessionCreated?.(res.id, content, res.initialMessageUuid)
      actionActiveRef.current = false
    } catch {
      setStaleError("Couldn't summarize right now")
    } finally {
      setIsSummarizing(false)
    }
  }, [agentSlug, sessionId, model, branchSession, onSessionCreated, draftStore, draftKey])

  // Start fresh: snapshot the live composer (text + files + model + effort), carry
  // it into the agent's new-chat composer, and navigate there. No session is
  // created until the user actually sends — the normal AgentHome path owns that.
  const handleStartFresh = useCallback(() => {
    const { draftText, carryover } = splitSnapshotForHandoff(composerSnapshotRef.current?.())
    // Text rides the agent's draft key; only overwrite when present so an empty
    // Start fresh doesn't clobber an existing agent-home draft.
    if (draftText !== undefined) draftStore.set(`agent:${agentSlug}`, draftText)
    draftStore.set(carryoverKey(agentSlug), carryover)
    // This is a move, not a copy — clear the source session's text draft.
    draftStore.set(draftKey, undefined)
    onStartFresh?.()
  }, [agentSlug, draftStore, draftKey, onStartFresh])

  return (
    <>
      <SessionThread
        sessionId={sessionId}
        agentSlug={agentSlug}
        browserActive={browserActive}
        pendingUserMessages={pendingUserMessages}
        pendingRequestCount={pendingRequestCount}
        onPendingMessageAppeared={onPendingMessageAppeared}
        suppressScrollToBottom={staleMenuOpen}
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
              {showToast && (
                <StaleSessionToast
                  onIgnore={() => setIgnored(true)}
                  onStartSummary={handleContinueSummary}
                  onStartFresh={handleStartFresh}
                  isSummarizing={isSummarizing}
                  summaryError={staleError}
                  onRetrySummary={handleContinueSummary}
                  onMenuOpenChange={setStaleMenuOpen}
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
                registerSnapshot={registerSnapshot}
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
    </>
  )
}
