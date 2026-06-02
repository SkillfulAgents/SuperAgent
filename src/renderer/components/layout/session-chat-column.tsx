import { MessageList } from '@renderer/components/messages/message-list'
import { MessageInput } from '@renderer/components/messages/message-input'
import { AgentActivityIndicator } from '@renderer/components/messages/agent-activity-indicator'
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
  const { isActive } = useMessageStream(sessionId, agentSlug)
  useFileDeliveryWatcher(sessionId, agentSlug)
  const { items: pendingRequestItems, count: pendingRequestCount } = usePendingRequests({
    sessionId,
    agentSlug,
    pendingUserMessage,
  })

  const renderCtx: RenderContext = { sessionId, agentSlug, readOnly: isViewOnly }

  return (
    <div className="flex-1 min-w-0 grid grid-rows-[1fr_auto] min-h-0">
      <MessageList
        sessionId={sessionId}
        agentSlug={agentSlug}
        pendingUserMessage={pendingUserMessage}
        pendingRequestCount={pendingRequestCount}
        onPendingMessageAppeared={onPendingMessageAppeared}
      />
      <div className="bg-background max-w-[740px] mx-auto w-full">
        <AgentActivityIndicator sessionId={sessionId} agentSlug={agentSlug} />
        {pendingRequestCount > 0 ? (
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
        )}
      </div>
    </div>
  )
}
