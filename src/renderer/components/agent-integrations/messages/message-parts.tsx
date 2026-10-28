import { useId, useState, type ReactNode } from 'react'
import { ArrowUpRight, ChevronRight } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { formatProviderName } from '@shared/lib/agent-integrations/presentation'
import type { IntegrationMessageDisplay, IntegrationMessagePerson } from '@shared/lib/agent-integrations/message-display-schema'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import type { IntegrationMessageProps } from './types'

/** When the person sent it: the provider's time, else when it reached the transcript. */
export function sentAtOf(display: IntegrationMessageDisplay, createdAt: Date | string): Date | null {
  const date = new Date(display.request?.sentAt ?? createdAt)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatSentAt(date: Date | null): string {
  if (!date) return ''
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (date.toDateString() === new Date().toDateString()) return time
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

const AVATAR_COLORS = ['#4A6FDC', '#2E8B78', '#C0673D', '#8B5CB8', '#B9464F', '#3F7FA6', '#7A8B2E']

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0] ?? '?']
  return letters.map((word) => Array.from(word)[0] ?? '').join('').slice(0, 2).toLocaleUpperCase()
}

/** A person's picture from the provider, or their initials on a stable color. */
export function PersonAvatar({ person, size = 36, className }: {
  person: IntegrationMessagePerson
  size?: number
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const hash = Array.from(person.name).reduce((value, char) => (Math.imul(value, 31) + char.codePointAt(0)!) >>> 0, 0)
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-semibold text-white', className)}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.36), background: AVATAR_COLORS[hash % AVATAR_COLORS.length] }}
    >
      {person.avatarUrl && !failed
        ? <img src={person.avatarUrl} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
        : initials(person.name)}
    </span>
  )
}

/** Opens the source in the provider. Links are validated https on the host. */
export function OpenInProviderLink({ href, provider, className }: { href: string; provider: string; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline', className)}
      data-testid="integration-message-link"
    >
      Open in {formatProviderName(provider)}
      <ArrowUpRight className="h-3 w-3" aria-hidden />
    </a>
  )
}

/**
 * Provider icon, platform and event, e.g. "Slack · Channel message". The
 * installation's own name follows when it differs from the platform's.
 */
export function IntegrationEventLine({ display, iconClassName, className, details = [], children }: {
  display: IntegrationMessageDisplay
  iconClassName?: string
  className?: string
  /** Short facts continuing the line (a chat name, a time). */
  details?: readonly (string | undefined)[]
  /** Elements beside the line, e.g. a right-aligned time. */
  children?: ReactNode
}) {
  const platform = formatProviderName(display.integration.provider)
  const name = display.integration.name
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground', className)} data-testid="integration-message-event">
      <ServiceIcon slug={display.integration.provider} fallback="mcp" className={cn('h-3.5 w-3.5 shrink-0', iconClassName)} />
      <span className="truncate">
        <span className="font-medium text-foreground/80">{platform}</span>
        <span aria-hidden> · </span>
        {display.event.label}
        {name !== platform && <span className="hidden sm:inline"> · via {name}</span>}
        {details.filter(Boolean).map((detail) => <span key={detail}> · {detail}</span>)}
      </span>
      {children}
    </div>
  )
}

function AgentInputToggle({ open, onToggle, controls }: { open: boolean; onToggle: () => void; controls: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
      data-testid="integration-message-agent-input-toggle"
    >
      <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} aria-hidden />
      Agent input
    </button>
  )
}

/**
 * Footer row shared by every card: the source link, and the raw text the agent
 * received, collapsed by default. The card shows the request; this keeps the
 * full context one click away.
 */
export function IntegrationMessageFooter({ display, message, link, className }: Pick<IntegrationMessageProps, 'display' | 'message'> & {
  link?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  return (
    <div className={cn('flex w-full flex-col gap-2', className)}>
      <div className="flex items-center justify-end gap-3 text-xs">
        <AgentInputToggle open={open} onToggle={() => setOpen((value) => !value)} controls={panelId} />
        {link && <OpenInProviderLink href={link} provider={display.integration.provider} />}
      </div>
      {open && (
        <pre
          id={panelId}
          className="max-h-72 w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 text-left font-mono text-[11px] leading-relaxed text-muted-foreground"
          data-testid="integration-message-agent-input"
        >
          {message.content.text}
        </pre>
      )}
    </div>
  )
}
