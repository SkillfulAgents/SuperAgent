import { useCallback, useMemo, useRef, useState } from 'react'
import { MessageInput } from '@renderer/components/messages/message-input'
import { SessionThread } from '@renderer/components/messages/session-thread'
import { PendingRequestStack } from '@renderer/components/messages/pending-request-stack'
import { renderPendingRequest, type RenderContext } from '@renderer/components/messages/pending-request-renderer'
import { PendingRequestErrorBoundary } from '@renderer/components/messages/pending-request-error-boundary'
import { usePendingRequests } from '@renderer/components/messages/use-pending-requests'
import { StaleSessionToast } from '@renderer/components/messages/stale-session-notice'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useFileDeliveryWatcher } from '@renderer/hooks/use-file-delivery-watcher'
import { useBranchSession, useCreateSession } from '@renderer/hooks/use-sessions'
import { useDraftsStore } from '@renderer/context/drafts-context'
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
  const shouldPrompt = useMemo(() => evaluateStalePrompt({
    idleMs: lastActivityAt ? Date.now() - lastActivityAt.getTime() : 0,
    contextTokens: currentContextTokens(contextUsage),
    isAwaitingInput,
    isRunning,
  }).shouldPrompt, [lastActivityAt, contextUsage, isAwaitingInput, isRunning])

  // Local Ignore (no persistence) + in-flight action state for the popover.
  const [ignored, setIgnored] = useState(false)
  const [isSummarizing, setIsSummarizing] = useState(false)
  const [staleError, setStaleError] = useState<string | null>(null)
  const [failedAction, setFailedAction] = useState<'summary' | 'newConversation' | null>(null)
  const actionActiveRef = useRef(false)

  const draftStore = useDraftsStore()
  const draftKey = `session:${sessionId}`
  const branchSession = useBranchSession()
  const createSession = useCreateSession()

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
    setFailedAction(null)
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
      setFailedAction('summary')
    } finally {
      setIsSummarizing(false)
    }
  }, [agentSlug, sessionId, model, branchSession, onSessionCreated, draftStore, draftKey])

  const handleNewConversation = useCallback(async () => {
    actionActiveRef.current = true
    setFailedAction(null)
    setStaleError(null)
    const content = draftStore.get<string>(draftKey) ?? ''
    try {
      const res = await createSession.mutateAsync({ agentSlug, message: content })
      if (!actionActiveRef.current) return
      draftStore.set(draftKey, undefined)
      onSessionCreated?.(res.id, content, res.initialMessageUuid)
      actionActiveRef.current = false
    } catch {
      setStaleError("Couldn't start a new conversation right now")
      setFailedAction('newConversation')
    }
  }, [agentSlug, createSession, onSessionCreated, draftStore, draftKey])

  return (
    <>
      <SessionThread
        sessionId={sessionId}
        agentSlug={agentSlug}
        browserActive={browserActive}
        pendingUserMessages={pendingUserMessages}
        pendingRequestCount={pendingRequestCount}
        onPendingMessageAppeared={onPendingMessageAppeared}
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
                  onStartFresh={handleNewConversation}
                  isSummarizing={isSummarizing}
                  summaryError={failedAction === 'summary' ? staleError : null}
                  onRetrySummary={handleContinueSummary}
                  isStartingFresh={createSession.isPending}
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
