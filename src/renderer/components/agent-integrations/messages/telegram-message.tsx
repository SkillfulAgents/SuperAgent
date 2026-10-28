import { BubbleTail } from './bubble-tail'
import { IntegrationEventLine, IntegrationMessageFooter, formatSentAt, sentAtOf } from './message-parts'
import type { IntegrationMessageProps } from './types'

/** A Telegram bubble: sender name in the accent color, text, then the time tucked in the corner. */
export function TelegramIntegrationMessage({ display, message, iconClassName }: IntegrationMessageProps) {
  const { request, source } = display
  const sentAt = sentAtOf(display, message.createdAt)
  const time = sentAt?.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const conversation = source.kind !== 'direct' && source.title && source.title !== request?.author?.name ? source.title : undefined
  return (
    <div className="flex w-full max-w-[560px] flex-col items-end gap-1.5" data-testid="integration-message" data-provider="telegram">
      <IntegrationEventLine
        display={display}
        iconClassName={iconClassName}
        className="justify-end"
        // The bubble shows the time; an older message also needs its date.
        details={[conversation, sentAt && time !== formatSentAt(sentAt) ? formatSentAt(sentAt) : undefined]}
      />
      <div className="relative mr-2.5 max-w-[85%]">
        <div className="rounded-[14px] bg-[#EEFFDE] px-2.5 pb-1.5 pt-1.5 text-[15px] leading-snug text-[#0F1419] shadow-[0_1px_1px_rgba(0,0,0,0.12)] dark:bg-[#2B5278] dark:text-white">
          {request?.author && (
            <div className="truncate text-[13px] font-semibold text-[#168ACD] dark:text-[#8CC4F2]" data-testid="integration-message-author">
              {request.author.name}
            </div>
          )}
          <div className="whitespace-pre-wrap break-words" data-testid="integration-message-request">
            {request?.text || <span className="italic opacity-70">Attachment</span>}
            {/* Reserves the corner so the last line never runs under the time. */}
            {time && <span className="inline-block w-[4.25rem]" aria-hidden />}
          </div>
          {time && (
            <div className="-mt-4 flex items-center justify-end gap-0.5 text-[11px] text-[#4FAE4E] tabular-nums dark:text-[#7DA8D3]">
              {time}
              <svg viewBox="0 0 18 12" width="18" height="12" aria-hidden className="shrink-0">
                <path d="M1 6.6 4 9.6 10 2.6M6.4 6.6 9.4 9.6 15.4 2.6" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          )}
        </div>
        <BubbleTail className="text-[#EEFFDE] dark:text-[#2B5278]" />
      </div>
      <IntegrationMessageFooter display={display} message={message} link={request?.url ?? source.url} className="mt-0.5" />
    </div>
  )
}
