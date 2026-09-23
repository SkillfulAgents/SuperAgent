import { BubbleTail } from './bubble-tail'
import { IntegrationEventLine, IntegrationMessageFooter, formatSentAt, sentAtOf } from './message-parts'
import type { IntegrationMessageProps } from './types'

/** A blue iMessage bubble, with the sender above it as Messages shows in a group. */
export function IMessageIntegrationMessage({ display, message, iconClassName }: IntegrationMessageProps) {
  const { request, source } = display
  const sentAt = formatSentAt(sentAtOf(display, message.createdAt))
  const conversation = source.kind !== 'direct' && source.title && source.title !== request?.author?.name ? source.title : undefined
  return (
    <div className="flex w-full max-w-[560px] flex-col items-end gap-1.5" data-testid="integration-message" data-provider="imessage">
      <IntegrationEventLine display={display} iconClassName={iconClassName} className="justify-end" details={[sentAt]} />
      {(request?.author || conversation) && (
        <div className="max-w-full truncate pr-3 text-[11px] text-muted-foreground" data-testid="integration-message-author">
          {request?.author?.name}{conversation && <span> in {conversation}</span>}
        </div>
      )}
      <div className="relative mr-2.5 max-w-[85%]">
        <div
          className="whitespace-pre-wrap break-words rounded-[18px] bg-[#0B84FF] px-3 py-[7px] text-[15px] leading-snug text-white"
          data-testid="integration-message-request"
        >
          {request?.text || <span className="italic opacity-80">Attachment</span>}
        </div>
        <BubbleTail className="text-[#0B84FF]" />
      </div>
      <IntegrationMessageFooter display={display} message={message} link={request?.url ?? source.url} className="mt-0.5" />
    </div>
  )
}
