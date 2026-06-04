import { MessageInput } from '@renderer/components/messages/message-input'
import { SessionThread } from '@renderer/components/messages/session-thread'
import { PendingRequestStack } from '@renderer/components/messages/pending-request-stack'
import { renderPendingRequest, type RenderContext } from '@renderer/components/messages/pending-request-renderer'
import { usePendingRequests } from '@renderer/components/messages/use-pending-requests'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useFileDeliveryWatcher } from '@renderer/hooks/use-file-delivery-watcher'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { DonutChart } from '@renderer/components/ui/donut-chart'
import type { EffortLevel } from '@shared/lib/container/types'

interface PendingMessage {
  text: string
  sentAt: number
  sender?: { id: string; name: string; email: string }
}

interface SessionChatColumnProps {
  sessionId: string
  agentSlug: string
  pendingUserMessage: PendingMessage | null
  isViewOnly: boolean
  contextPercent: number | null
  effort?: EffortLevel
  model?: string
  onPendingMessageAppeared: () => void
  onMessageSent: (content: string) => void
}

export function SessionChatColumn({
  sessionId,
  agentSlug,
  pendingUserMessage,
  isViewOnly,
  contextPercent,
  effort,
  model,
  onPendingMessageAppeared,
  onMessageSent,
}: SessionChatColumnProps) {
  const { isActive, browserActive } = useMessageStream(sessionId, agentSlug)
  useFileDeliveryWatcher(sessionId, agentSlug)
  const { items: pendingRequestItems, count: pendingRequestCount } = usePendingRequests({
    sessionId,
    agentSlug,
    pendingUserMessage,
  })

  const renderCtx: RenderContext = { sessionId, agentSlug, readOnly: isViewOnly }

  return (
    <SessionThread
      sessionId={sessionId}
      agentSlug={agentSlug}
      browserActive={browserActive}
      pendingUserMessage={pendingUserMessage}
      pendingRequestCount={pendingRequestCount}
      onPendingMessageAppeared={onPendingMessageAppeared}
      footerClassName="bg-background max-w-[740px] mx-auto w-full"
      footer={
        pendingRequestCount > 0 ? (
          <div className="px-4 pb-4" data-testid="pending-request-slot">
            <PendingRequestStack>
              {pendingRequestItems.map((d) => renderPendingRequest(d, renderCtx))}
            </PendingRequestStack>
          </div>
        ) : (
          <>
            <MessageInput
              key={sessionId}
              sessionId={sessionId}
              agentSlug={agentSlug}
              onMessageSent={onMessageSent}
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
  )
}
