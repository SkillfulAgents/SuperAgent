import type { IntegrationMessageSource } from '@shared/lib/agent-integrations/message-display-schema'
import { cn } from '@shared/lib/utils/cn'
import { IntegrationEventLine, IntegrationMessageFooter, PersonAvatar, formatSentAt, sentAtOf } from './message-parts'
import type { IntegrationMessageProps } from './types'

type StatusCategory = NonNullable<NonNullable<IntegrationMessageSource['status']>['category']>

// Linear's workflow-state glyphs and colors.
const STATUS_COLORS: Record<StatusCategory, string> = {
  triage: 'text-[#FC7840]',
  backlog: 'text-[#95A2B3]',
  unstarted: 'text-[#95A2B3]',
  started: 'text-[#F2C94C]',
  completed: 'text-[#5E6AD2]',
  canceled: 'text-[#95A2B3]',
}

export function LinearStatusIcon({ category, className }: { category?: StatusCategory; className?: string }) {
  const color = category ? STATUS_COLORS[category] : 'text-muted-foreground'
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={cn('h-3.5 w-3.5 shrink-0', color, className)} data-status={category ?? 'unknown'}>
      {category === 'completed' || category === 'canceled' ? (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path d={category === 'completed' ? 'M4.4 7.2 6.2 9 9.7 5.3' : 'M4.9 4.9l4.2 4.2M9.1 4.9 4.9 9.1'} stroke="white" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={category === 'backlog' ? '1.4 1.6' : undefined} />
          {category === 'started' && <path d="M7 3.5A3.5 3.5 0 0 1 7 10.5Z" fill="currentColor" />}
          {category === 'triage' && <circle cx="7" cy="7" r="2" fill="currentColor" />}
        </>
      )}
    </svg>
  )
}

/** Linear's priority glyph: urgent is a filled badge, the rest are signal bars. */
export function LinearPriorityIcon({ level, className }: { level: number; className?: string }) {
  if (level === 1) {
    return (
      <svg viewBox="0 0 14 14" aria-hidden className={cn('h-3.5 w-3.5 shrink-0 text-[#FC7840]', className)}>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
        <path d="M7 3.8v4M7 10.1v.1" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    )
  }
  if (level === 0) {
    return (
      <svg viewBox="0 0 14 14" aria-hidden className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', className)}>
        {[2, 6, 10].map((x) => <rect key={x} x={x} y="6.25" width="2.5" height="1.5" rx="0.5" fill="currentColor" />)}
      </svg>
    )
  }
  const filled = 5 - level // high 3, medium 2, low 1
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', className)}>
      {[0, 1, 2].map((bar) => (
        <rect key={bar} x={1.5 + bar * 4} y={8 - bar * 3} width="3" height={4.5 + bar * 3} rx="1" fill="currentColor" opacity={bar < filled ? 1 : 0.3} />
      ))}
    </svg>
  )
}

/** An excerpt of Linear Markdown: inline `code` spans styled, everything else plain text. */
function InlineCode({ text }: { text: string }) {
  return text.split(/`([^`\n]+)`/).map((part, index) => index % 2
    ? <code key={index} className="rounded bg-muted px-1 py-px font-mono text-[12px] text-foreground/80">{part}</code>
    : part)
}

/**
 * A Linear ticket preview, as the issue appears in Linear, with the comment
 * that invoked the agent (when there is one) beneath it.
 */
export function LinearIntegrationMessage({ display, message, renderMarkdown, iconClassName }: IntegrationMessageProps) {
  const { request, source, task } = display
  const sentAt = formatSentAt(sentAtOf(display, message.createdAt))
  const people = [task?.assignee && `Assignee: ${task.assignee}`, task?.project, task?.team].filter(Boolean) as string[]
  return (
    <div className="flex w-full max-w-[560px] flex-col items-end gap-1.5" data-testid="integration-message" data-provider="linear">
      <div className="w-full overflow-hidden rounded-xl border border-border bg-background text-left shadow-sm">
        <IntegrationEventLine display={display} iconClassName={iconClassName} className="border-b border-border bg-muted/30 px-3 py-2">
          {!request && sentAt && <span className="ml-auto shrink-0 pl-2 tabular-nums">{sentAt}</span>}
        </IntegrationEventLine>

        <div className="space-y-1.5 px-3 py-2.5" data-testid="linear-ticket-preview">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {source.identifier && <span className="font-medium tabular-nums text-muted-foreground">{source.identifier}</span>}
            {source.status && (
              <span className="inline-flex items-center gap-1" data-testid="linear-ticket-status">
                <LinearStatusIcon category={source.status.category} />
                <span className="text-foreground/80">{source.status.name}</span>
              </span>
            )}
            {task?.priority && task.priority.level > 0 && (
              <span className="inline-flex items-center gap-1">
                <LinearPriorityIcon level={task.priority.level} />
                {task.priority.label}
              </span>
            )}
          </div>
          {source.title && (
            source.url
              ? <a href={source.url} target="_blank" rel="noopener noreferrer" className="block text-[15px] font-semibold leading-snug text-foreground hover:underline">{source.title}</a>
              : <div className="text-[15px] font-semibold leading-snug text-foreground">{source.title}</div>
          )}
          {task?.description && (
            <p className="line-clamp-3 whitespace-pre-line break-words text-[13px] leading-relaxed text-muted-foreground">
              <InlineCode text={task.description} />
            </p>
          )}
          {(task?.labels?.length || people.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs text-muted-foreground">
              {task?.labels?.map((label) => (
                <span key={label} className="rounded-full border border-border px-2 py-px text-[11px] text-foreground/80">{label}</span>
              ))}
              {people.length > 0 && <span className="truncate">{people.join(' · ')}</span>}
            </div>
          )}
        </div>

        {request && (
          <div className="flex gap-2.5 border-t border-border bg-muted/20 px-3 py-2.5" data-testid="linear-comment">
            {request.author && <PersonAvatar person={request.author} size={22} className="mt-0.5 rounded-full" />}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-xs">
                {request.author && <span className="font-medium text-foreground" data-testid="integration-message-author">{request.author.name}</span>}
                {sentAt && <span className="text-muted-foreground tabular-nums">{sentAt}</span>}
              </div>
              <div className="text-sm [&_p]:my-0" data-testid="integration-message-request">{renderMarkdown(request.text)}</div>
            </div>
          </div>
        )}
      </div>
      <IntegrationMessageFooter display={display} message={message} link={source.url ?? request?.url} />
    </div>
  )
}
