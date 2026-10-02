import { Check, Loader2 } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { TODO_ASK_LABELS, todoDisplayTitle } from '@shared/lib/todos/todo-schema'
import { Button } from '@renderer/components/ui/button'
import type { TodoView } from '@renderer/hooks/use-todos'
import type { TodoCardAction } from './todo-card-action'
import { ShortcutTooltip } from './todo-shortcuts'
import { ago, when, type TodoAgent } from './todo-shared'

const PILL = 'ml-auto inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px]'

/**
 * What a card in Needs you wants: blocked work says what it is waiting for
 * (orange); work with output to look at says so (blue).
 */
function AskPill({ todo }: { todo: TodoView }) {
  if (todo.column === 'has_updates') {
    return (
      <span className={cn(PILL, 'bg-blue-500/10 text-blue-700 dark:text-blue-400')} data-testid="todo-card-updates">
        Has updates
      </span>
    )
  }
  if (todo.column !== 'needs_input' || !todo.ask) return null
  return (
    <span className={cn(PILL, 'bg-orange-500/10 text-orange-700 dark:text-orange-400')} data-testid="todo-card-ask">
      {TODO_ASK_LABELS[todo.ask]}
    </span>
  )
}

/**
 * A board card: the title, then one metadata row — the agent first, then what
 * matters for the column. Clicking anywhere opens it: a draft opens its
 * dialog, started work its session. On hover or selection a corner button
 * runs the card's action (start, mark done, archive).
 */
export function TodoBoardCard({ todo, agent, action, starting, onOpen, selected, onHover }: {
  todo: TodoView
  /** The agent it is given to, when that agent still exists. */
  agent: TodoAgent | undefined
  action: TodoCardAction | null
  /** Its start is in flight: the agent's session is being created. */
  starting: boolean
  onOpen: (todo: TodoView) => void
  /** The card keyboard shortcuts act on; hovering selects, as in Linear. */
  selected?: boolean
  onHover?: (todo: TodoView) => void
}) {
  const title = todoDisplayTitle(todo)
  const finished = todo.column === 'done' || todo.column === 'archived'
  const sep = <span aria-hidden="true">·</span>
  // Finished work whose session was deleted has nothing left to open, and a
  // draft mid-start has no draft left to edit and no session yet to open.
  const openable = !starting && (todo.column === 'drafts' || !!todo.sessionId)
  const shownAction = starting ? null : action

  return (
    <div
      className={cn(
        'group/card relative w-full scroll-my-2 rounded-lg border border-border/30 bg-card text-left shadow-sm transition-[border-color,box-shadow] hover:border-border/60 hover:shadow-md',
        selected && 'border-border/70 shadow-md ring-1 ring-ring/40',
      )}
      onMouseEnter={() => onHover?.(todo)}
      data-testid="todo-card"
      data-todo-id={todo.id}
      data-selected={selected || undefined}
      data-column={todo.column}
    >
      {/* The whole card is the open target; the action button sits above it.
          A button can't hold another button, so this one covers the card. */}
      {openable && (
        <button
          type="button"
          onClick={() => onOpen(todo)}
          aria-label={`Open ${title}`}
          aria-haspopup={todo.column === 'drafts' ? 'dialog' : undefined}
          className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      )}

      {shownAction && (
        <ShortcutTooltip label={shownAction.label} keys={[shownAction.shortcut]}>
          <Button
            variant="outline"
            size="icon"
            className={cn(
              'absolute right-2 top-2 z-10 h-7 w-7 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/card:opacity-100',
              selected && 'opacity-100',
            )}
            aria-label={`${shownAction.label}: ${title}`}
            aria-keyshortcuts={shownAction.shortcut}
            onClick={shownAction.run}
            data-testid={shownAction.testId}
          >
            <shownAction.Icon className={cn('h-3.5 w-3.5', shownAction.iconClass)} />
          </Button>
        </ShortcutTooltip>
      )}

      <div className="pointer-events-none relative flex flex-col gap-2 p-3">
        <p className={cn('text-sm leading-snug', shownAction && 'pr-8', finished ? 'text-muted-foreground' : 'text-foreground')}>
          {title}
        </p>

        <p className="flex h-5 min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
          {agent && (
            <span className="min-w-[2.5rem] truncate text-foreground/80">{agent.name}</span>
          )}

          {todo.column === 'drafts' && (
            starting ? (
              <>
                {agent && sep}
                <span className="inline-flex shrink-0 items-center gap-1" data-testid="todo-card-starting">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Starting…
                </span>
              </>
            ) : (
              <>
                {agent && sep}
                <span className="shrink-0">Edited {when(todo.updatedAt)}</span>
              </>
            )
          )}


          <AskPill todo={todo} />

          {todo.column === 'working' && (
            <>
              {agent && sep}
              <span className="todo-shimmer min-w-0 flex-1 truncate" data-testid="todo-card-status">Working…</span>
            </>
          )}

          {todo.column === 'done' && (
            <span className="ml-auto inline-flex min-w-0 items-center gap-1">
              <Check className="h-3 w-3 shrink-0 text-emerald-500" />
              <span className="truncate">Done {ago(todo.completedAt ?? todo.updatedAt)}</span>
            </span>
          )}

          {todo.column === 'archived' && (
            <span className="ml-auto min-w-0 truncate">
              {/* A draft archived before it was ever started says so. */}
              {todo.startedAt === null ? 'Draft, archived' : 'Archived'} {ago(todo.updatedAt)}
            </span>
          )}
        </p>
      </div>
    </div>
  )
}
