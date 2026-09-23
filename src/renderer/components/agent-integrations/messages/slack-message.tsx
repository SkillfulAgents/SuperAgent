import { Hash, Lock, MessagesSquare } from 'lucide-react'
import { IntegrationEventLine, IntegrationMessageFooter, PersonAvatar, formatSentAt, sentAtOf } from './message-parts'
import type { IntegrationMessageProps } from './types'

function ChannelLabel({ kind, title }: { kind: string; title?: string }) {
  if (kind === 'direct') return <span>Direct message</span>
  const name = title?.replace(/^#/, '')
  const Icon = kind === 'thread' ? MessagesSquare : kind === 'group' ? Lock : Hash
  return (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{kind === 'thread' && name ? `Thread in #${name}` : name ?? 'Channel'}</span>
    </span>
  )
}

/** A Slack message as Slack draws it: square avatar, bold name, time, then the text. */
export function SlackIntegrationMessage({ display, message, renderMarkdown, iconClassName }: IntegrationMessageProps) {
  const { request, source } = display
  const author = request?.author ?? { name: 'Slack user' }
  const sentAt = formatSentAt(sentAtOf(display, message.createdAt))
  return (
    <div className="flex w-full max-w-[560px] flex-col items-end gap-1.5" data-testid="integration-message" data-provider="slack">
      <div className="w-full overflow-hidden rounded-xl border border-border bg-background text-left shadow-sm">
        <IntegrationEventLine display={display} iconClassName={iconClassName} className="border-b border-border bg-muted/30 px-3 py-2">
          <span className="ml-auto flex min-w-0 shrink items-center gap-1 pl-2 text-xs text-muted-foreground" data-testid="slack-message-channel">
            <ChannelLabel kind={source.kind} title={source.title} />
            {source.workspace && <span className="hidden shrink-0 sm:inline">· {source.workspace}</span>}
          </span>
        </IntegrationEventLine>
        <div className="flex gap-2.5 px-3 py-2.5">
          <PersonAvatar person={author} size={36} className="rounded-lg" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="truncate text-[15px] font-bold text-foreground" data-testid="integration-message-author">{author.name}</span>
              {sentAt && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{sentAt}</span>}
            </div>
            {request?.text ? (
              <div className="text-[15px] leading-[1.46] [&_p]:my-0" data-testid="integration-message-request">{renderMarkdown(request.text)}</div>
            ) : (
              <p className="text-sm italic text-muted-foreground">Shared files</p>
            )}
          </div>
        </div>
      </div>
      <IntegrationMessageFooter display={display} message={message} link={request?.url ?? source.url} />
    </div>
  )
}
