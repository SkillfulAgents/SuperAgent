import { format, isToday } from 'date-fns'
import { Check, Clock } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import type { TodoCard } from './todo-schema'
import { attentionKind, relativeTime } from './todo-shared'
import { useCardAction } from './todo-card-action'
import { ShortcutTooltip } from './todo-shortcuts'

/** Linear-style compact age for the metadata row: "now", "8m", "3h", "2d", then a date. */
function ago(ts: number): string {
  const minutes = Math.floor((Date.now() - ts) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d`
  return format(ts, 'MMM d')
}

function when(ts: number): string {
  if (Date.now() - ts < 60_000) return 'just now'
  return isToday(ts) ? relativeTime(ts) : format(ts, 'MMM d')
}

/** What a Needs you card is waiting for, as a short pill. */
function askLabel(card: TodoCard): string {
  if (card.attentionReason === 'review') return 'Ready for review'
  if (card.attentionReason === 'action') return attentionKind(card)
  return 'Needs answer'
}

/** The ask on a Needs you card, as a small pill at the end of the metadata row. */
function AskPill({ card }: { card: TodoCard }) {
  return (
    <span
      className={cn(
        'ml-auto inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px]',
        card.attentionReason === 'review'
          ? 'bg-sky-500/10 text-sky-700 dark:text-sky-400'
          : 'bg-orange-500/10 text-orange-700 dark:text-orange-400',
      )}
    >
      {askLabel(card)}
    </span>
  )
}

/** The right-hand end of the row for finished work. */
function Outcome({ card }: { card: TodoCard }) {
  if (card.column === 'archive') return <span className="ml-auto min-w-0 truncate">Archived {ago(card.updatedAt)}</span>
  return card.source === 'recurring' ? (
    <span className="ml-auto inline-flex min-w-0 items-center gap-1">
      <Clock className="h-3 w-3 shrink-0" />
      <span className="truncate">Waiting for next run</span>
    </span>
  ) : (
    <span className="ml-auto inline-flex min-w-0 items-center gap-1">
      <Check className="h-3 w-3 shrink-0 text-emerald-500" />
      <span className="truncate">Done {ago(card.updatedAt)}</span>
    </span>
  )
}

/**
 * A board card: the title, then one metadata row — the agent first, then what
 * matters for the column. Clicking anywhere opens it: a draft opens its
 * dialog, anything else its session page. On hover or focus a corner button
 * starts a draft, marks work in flight done, or archives what is already done.
 */
export function TodoBoardCard({ card, onOpen, selected, onHover }: {
  card: TodoCard
  onOpen: (card: TodoCard) => void
  /** The card keyboard shortcuts act on; hovering selects, as in Linear. */
  selected?: boolean
  onHover?: (card: TodoCard) => void
}) {
  const names = card.agents.map((a) => a.name).join(' & ')
  const hasAgent = card.agents.length > 0
  const sep = <span aria-hidden="true">·</span>
  const title = card.title.trim() || 'Untitled task'
  // The same action the item's session page shows in its top right.
  const action = useCardAction(card)

  return (
    <div
      className={cn(
        'group/card relative w-full scroll-my-2 rounded-lg border border-border/30 bg-card text-left shadow-sm transition-[border-color,box-shadow] hover:border-border/60 hover:shadow-md',
        selected && 'border-border/70 shadow-md ring-1 ring-ring/40',
      )}
      onMouseEnter={() => onHover?.(card)}
      data-testid="todo-card"
      data-card-id={card.id}
      data-selected={selected || undefined}
      data-status={card.column}
    >
      {/* The whole card is the open target; the check sits above it. A button
          can't hold another button, so this one covers the card instead. */}
      <button
        type="button"
        onClick={() => onOpen(card)}
        aria-label={`Open ${title}`}
        aria-haspopup={card.column === 'drafts' ? 'dialog' : undefined}
        className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />

      {action && (
        <ShortcutTooltip label={action.label} keys={[action.shortcut]}>
          <Button
            variant="outline"
            size="icon"
            className={cn(
              'absolute right-2 top-2 z-10 h-7 w-7 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/card:opacity-100',
              selected && 'opacity-100',
            )}
            aria-label={`${action.label}: ${title}`}
            aria-keyshortcuts={action.shortcut}
            onClick={action.run}
            data-testid={action.testId}
          >
            <action.Icon className={cn('h-3.5 w-3.5', action.iconClass)} />
          </Button>
        </ShortcutTooltip>
      )}

      <div className="pointer-events-none relative flex flex-col gap-2 p-3">
      <p className={cn('text-sm leading-snug', action && 'pr-8', card.column === 'done' || card.column === 'archive' ? 'text-muted-foreground' : 'text-foreground')}>
        {card.title.trim() || <span className="text-muted-foreground">Untitled task</span>}
      </p>

      <p className="flex h-5 min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
        {/* The name keeps a minimum width so the time and pill can't squeeze it away. */}
        {hasAgent && <span className="min-w-[2.5rem] truncate text-foreground/80">{names}</span>}

        {card.column === 'drafts' && (
          <>
            {hasAgent && sep}
            <span className="shrink-0">Edited {when(card.updatedAt)}</span>
          </>
        )}

        {card.column === 'attention' && (
          <>
            {hasAgent && sep}
            <span className="shrink-0 tabular-nums">{ago(card.updatedAt)}</span>
            <AskPill card={card} />
          </>
        )}

        {card.column === 'working' && (
          <>
            {hasAgent && sep}
            <span className="todo-shimmer min-w-0 flex-1 truncate" data-testid="todo-card-status">
              {card.lastUpdate?.startsWith('You: ') ? 'Working…' : (card.lastUpdate ?? 'Working…')}
            </span>
          </>
        )}

        {(card.column === 'done' || card.column === 'archive') && <Outcome card={card} />}
      </p>
      </div>
    </div>
  )
}
