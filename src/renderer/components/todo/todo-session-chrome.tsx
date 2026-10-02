import { useNavigate } from '@tanstack/react-router'
import { ArrowDown, ArrowLeft, ArrowUp } from 'lucide-react'
import { byBoardOrder } from '@shared/lib/todos/todo-schema'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { useExperiment } from '@renderer/hooks/use-experiment'
import { useTodos, type TodoView } from '@renderer/hooks/use-todos'
import { cardActionFor, useTodoActionRunners } from './todo-card-action'
import { ShortcutTooltip, usePlainKeys } from './todo-shortcuts'

/*
 * The Todo board's chrome in a session's header. A session started from the
 * board is one of its items, so its header gets the board's navigation: back
 * to the board on the left; on the right, a stepper through everything
 * waiting on the person and the item's own action (mark done, archive).
 * Sessions that are not on the board, and people without the experiment,
 * see the header as it always was.
 */

/** Everything waiting on the person, in board order: input needed first, then updates to look at. */
export function todoQueue(todos: readonly TodoView[]): TodoView[] {
  return [
    ...todos.filter((t) => t.column === 'needs_input').sort(byBoardOrder),
    ...todos.filter((t) => t.column === 'has_updates').sort(byBoardOrder),
  ]
}

/** The board item this session belongs to, if the person has the board on. */
export function useSessionTodo(agentSlug: string, sessionId: string | null): {
  todo: TodoView | undefined
  todos: TodoView[]
} {
  const enabled = useExperiment('todo-board')
  const { data } = useTodos()
  const todos = enabled ? data ?? [] : []
  const todo = sessionId ? todos.find((t) => t.agentSlug === agentSlug && t.sessionId === sessionId) : undefined
  return { todo, todos }
}

function useOpenTodo() {
  const navigate = useNavigate()
  return (todo: TodoView | null | undefined) => {
    if (!todo?.agentSlug || !todo.sessionId) return
    void navigate({ to: '/agents/$slug/sessions/$sessionId', params: { slug: todo.agentSlug, sessionId: todo.sessionId } })
  }
}

/** Something else has the keyboard: a dialog or a menu is open over the session. */
function overlayOpen(): boolean {
  return !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')
}

/** Left of the breadcrumb: back to the board. */
export function TodoSessionBack({ agentSlug, sessionId }: { agentSlug: string; sessionId: string }) {
  const { todo } = useSessionTodo(agentSlug, sessionId)
  const navigate = useNavigate()
  const back = () => void navigate({ to: '/todo' })

  usePlainKeys((event) => {
    if (event.key !== 'Escape' || overlayOpen()) return false
    back()
    return true
  }, !!todo)

  if (!todo) return null
  return (
    <ShortcutTooltip label="Back to board" keys={['Esc']}>
      <Button
        variant="outline"
        size="icon"
        className="app-no-drag h-8 w-8 shrink-0 text-muted-foreground"
        aria-label="Back to board"
        aria-keyshortcuts="Escape"
        onClick={back}
        data-testid="todo-session-back"
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>
    </ShortcutTooltip>
  )
}

/** Right side of the header: step through what is waiting on you, then the item's action. */
export function TodoSessionControls({ agentSlug, sessionId }: { agentSlug: string; sessionId: string }) {
  const { todo, todos } = useSessionTodo(agentSlug, sessionId)
  const openTodo = useOpenTodo()
  const runners = useTodoActionRunners()
  // The item's own action; a draft has no session, so it is never this one.
  const action = cardActionFor(todo, runners, () => {})

  const queue = todoQueue(todos)
  const index = todo ? queue.findIndex((t) => t.id === todo.id) : -1
  const prev = index > 0 ? queue[index - 1] : null
  // From an item outside the queue (say, one that is working), down enters it at the top.
  const next = index === -1 ? (queue[0] ?? null) : (queue[index + 1] ?? null)

  usePlainKeys((event) => {
    if (overlayOpen()) return false
    const key = event.key.toUpperCase()
    if (key === 'J' && next) { openTodo(next); return true }
    if (key === 'K' && prev) { openTodo(prev); return true }
    if (action && key === action.shortcut) { action.run(); return true }
    return false
  }, !!todo)

  if (!todo) return null
  return (
    <div className="flex shrink-0 items-center gap-2 md:mr-1" data-testid="todo-session-controls">
      {queue.length > 0 && (
        <>
          <span className="hidden text-xs tabular-nums text-muted-foreground md:inline" data-testid="todo-session-position">
            {index === -1 ? `${queue.length} waiting` : `${index + 1} / ${queue.length}`}
          </span>
          {/* One split control: down and up share a border. */}
          <div className="flex items-center">
            <ShortcutTooltip label="Next that needs you" keys={['J']}>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 rounded-r-none text-muted-foreground"
                disabled={!next}
                onClick={() => openTodo(next)}
                aria-label="Next that needs you"
                aria-keyshortcuts="J"
                data-testid="todo-session-next"
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
            </ShortcutTooltip>
            <ShortcutTooltip label="Previous that needs you" keys={['K']}>
              <Button
                variant="outline"
                size="icon"
                className="-ml-px h-8 w-8 rounded-l-none text-muted-foreground"
                disabled={!prev}
                onClick={() => openTodo(prev)}
                aria-label="Previous that needs you"
                aria-keyshortcuts="K"
                data-testid="todo-session-prev"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            </ShortcutTooltip>
          </div>
        </>
      )}
      {action && (
        <ShortcutTooltip label={action.label} keys={[action.shortcut]}>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground"
            aria-label={action.label}
            aria-keyshortcuts={action.shortcut}
            onClick={action.run}
            data-testid={action.testId}
          >
            <action.Icon className={cn('h-4 w-4', action.iconClass)} />
          </Button>
        </ShortcutTooltip>
      )}
    </div>
  )
}
