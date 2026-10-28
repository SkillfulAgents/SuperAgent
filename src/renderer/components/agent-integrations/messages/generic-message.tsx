import { PersonAvatar, IntegrationEventLine, IntegrationMessageFooter, formatSentAt, sentAtOf } from './message-parts'
import type { IntegrationMessageProps } from './types'

/**
 * Any provider without its own preview, including one this version of the app
 * does not know: platform, event, source and the request, all as plain text.
 */
export function GenericIntegrationMessage({ display, message, iconClassName }: IntegrationMessageProps) {
  const { request, source } = display
  const sentAt = formatSentAt(sentAtOf(display, message.createdAt))
  const sourceLabel = [source.identifier, source.title].filter(Boolean).join(' · ')
  return (
    <div className="flex w-full max-w-[560px] flex-col items-end gap-1.5" data-testid="integration-message" data-provider={display.integration.provider}>
      <div className="w-full rounded-xl border border-border bg-background p-3 text-sm shadow-sm">
        <IntegrationEventLine display={display} iconClassName={iconClassName}>
          {sentAt && <span className="ml-auto shrink-0 tabular-nums">{sentAt}</span>}
        </IntegrationEventLine>
        {(sourceLabel || source.status) && (
          <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {sourceLabel && <span className="truncate">{sourceLabel}</span>}
            {source.status && <span className="shrink-0 rounded-full border border-border px-1.5 py-px">{source.status.name}</span>}
          </div>
        )}
        {request && (
          <div className="mt-2 flex gap-2.5">
            {request.author && <PersonAvatar person={request.author} size={24} className="mt-0.5 rounded-full" />}
            <div className="min-w-0 flex-1">
              {request.author && <div className="text-xs font-medium text-foreground">{request.author.name}</div>}
              <p className="whitespace-pre-wrap break-words text-foreground">{request.text}</p>
            </div>
          </div>
        )}
      </div>
      <IntegrationMessageFooter display={display} message={message} link={request?.url ?? source.url} />
    </div>
  )
}
