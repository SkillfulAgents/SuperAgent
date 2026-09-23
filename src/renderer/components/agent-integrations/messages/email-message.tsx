import { ChevronDown, Paperclip } from 'lucide-react'
import { IntegrationEventLine, IntegrationMessageFooter, PersonAvatar, formatSentAt, sentAtOf } from './message-parts'
import type { IntegrationMessageProps } from './types'

/** A mail reading pane. External content is always text; no tracking images or HTML. */
export function EmailIntegrationMessage({ display, message, iconClassName }: IntegrationMessageProps) {
  const { request, source, email } = display
  const author = request?.author ?? { name: email?.from || 'Unknown sender' }
  const sentAt = sentAtOf(display, message.createdAt)
  return (
    <div className="flex w-full max-w-[600px] flex-col items-end gap-1.5" data-testid="integration-message" data-provider="platform-email">
      <article className="w-full min-w-0 overflow-hidden rounded-xl border border-border bg-background text-left shadow-sm" aria-label="Email message">
        <header className="border-b border-border bg-muted/20 px-4 py-3">
          <IntegrationEventLine display={display} iconClassName={iconClassName} />
          <h3 className="mt-2 break-words text-base font-semibold leading-snug text-foreground" data-testid="email-subject">{source.title || '(No subject)'}</h3>
        </header>
        <div className="px-4 py-3">
          <div className="flex items-start gap-2.5">
            <PersonAvatar person={author} size={32} className="mt-0.5 rounded-full" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="break-words text-sm font-semibold text-foreground" data-testid="integration-message-author">{author.name}</span>
                {sentAt && <time dateTime={sentAt.toISOString()} title={sentAt.toLocaleString()} className="text-xs tabular-nums text-muted-foreground">{formatSentAt(sentAt)}</time>}
              </div>
              {email && (
                <details className="group mt-0.5 text-xs text-muted-foreground" data-testid="email-envelope">
                  <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
                    <span className="min-w-0 truncate">To {email.to[0] || 'undisclosed recipients'}{email.to.length > 1 && ` +${email.to.length - 1}`}{email.cc.length > 0 && ` · ${email.cc.length} Cc`}</span>
                    <ChevronDown className="h-3 w-3 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
                  </summary>
                  <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md bg-muted/40 p-2.5 leading-relaxed">
                    <dt>From</dt><dd className="break-words text-foreground">{email.from}</dd>
                    <dt>To</dt><dd className="break-words">{email.to.join(', ') || 'Undisclosed recipients'}</dd>
                    {!!email.cc.length && <><dt>Cc</dt><dd className="break-words">{email.cc.join(', ')}</dd></>}
                    {!!email.replyTo.length && <><dt>Reply to</dt><dd className="break-words">{email.replyTo.join(', ')}</dd></>}
                  </dl>
                  {email.recipientsTruncated && <p className="mt-1">Recipient list shortened. See Agent input for the original To/Cc headers.</p>}
                </details>
              )}
            </div>
          </div>
          {request?.text ? (
            <div className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground" data-testid="integration-message-request">{request.text}</div>
          ) : <p className="mt-4 text-sm italic text-muted-foreground">{email?.attachmentCount ? 'See attached files.' : 'No message body.'}</p>}
          {email?.quotedText && (
            <details className="mt-3 text-xs text-muted-foreground" data-testid="email-quoted-history">
              <summary className="w-fit cursor-pointer rounded px-1 py-0.5 hover:bg-muted hover:text-foreground">Quoted history</summary>
              <div className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-sm leading-relaxed">{email.quotedText}</div>
            </details>
          )}
          {!!email?.attachmentCount && (
            <div className="mt-4 flex items-center gap-1.5 border-t border-border pt-2.5 text-xs text-muted-foreground">
              <Paperclip className="h-3.5 w-3.5" aria-hidden />
              {email.attachmentCount} {email.attachmentCount === 1 ? 'attachment' : 'attachments'}
            </div>
          )}
        </div>
      </article>
      <IntegrationMessageFooter display={display} message={message} />
    </div>
  )
}
