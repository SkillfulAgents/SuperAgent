import { teamsCardLink } from '@shared/lib/chat-integrations/teams-deep-links'
import { File, MessagesSquare } from 'lucide-react'
import { IntegrationEventLine, IntegrationMessageFooter, PersonAvatar, formatSentAt, sentAtOf } from './message-parts'
import type { IntegrationMessageProps } from './types'

export function TeamsIntegrationMessage({ display, message, renderMarkdown }: IntegrationMessageProps) {
  const { request, source } = display
  const link = teamsCardLink(request?.url, source)
  const author = request?.author ?? { name: 'Teams member' }
  const time = formatSentAt(sentAtOf(display, message.createdAt))
  const location = [source.workspace, source.title].filter(Boolean).join(' / ')
  return <div className="flex w-full max-w-[560px] flex-col items-end gap-1.5" data-testid="integration-message" data-provider="teams">
    <div className="w-full overflow-hidden rounded-card border border-border bg-card text-left shadow-sm">
      <div className="space-y-1 border-b border-border bg-muted/35 px-3 py-2">
        <IntegrationEventLine display={display} />
        {location && <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={location}>
          <MessagesSquare className="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-300" aria-hidden />
          <span className="truncate">{location}</span>
        </span>}
      </div>
      <div className="flex items-start gap-2.5 p-3">
        <PersonAvatar person={author} size={32} className="rounded-full" />
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="font-semibold text-foreground" data-testid="integration-message-author">{author.name}</span>
            {time && <span className="text-muted-foreground tabular-nums">{time}</span>}
          </div>
          <div className="w-fit max-w-full break-words rounded-item rounded-tl-sm bg-indigo-50/75 px-3 py-2 text-sm text-foreground dark:bg-indigo-400/10 [&_p]:my-0" data-testid="integration-message-request">
            {request?.text ? renderMarkdown(request.text) : <span className="inline-flex items-center gap-1.5 text-muted-foreground"><File size={14} />Shared attachment</span>}
          </div>
        </div>
      </div>
    </div>
    <IntegrationMessageFooter display={display} message={message} link={link?.href} linkLabel={link?.chat ? 'Open chat in Microsoft Teams' : undefined} />
  </div>
}
