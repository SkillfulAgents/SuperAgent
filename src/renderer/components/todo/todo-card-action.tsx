import { useMemo } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Archive, Check, Play } from 'lucide-react'
import { toast } from 'sonner'
import { useSetTodoStatus, useStartTodo, type TodoView } from '@renderer/hooks/use-todos'

export interface TodoCardAction {
  label: string
  Icon: LucideIcon
  run: () => void
  /** What the action does to the item. */
  kind: 'start' | 'done' | 'archive'
  /** Its single-key shortcut, the same wherever the item shows it. */
  shortcut: 'S' | 'D' | 'E'
  testId: string
  /** Extra icon classes: Play is drawn filled and a step smaller. `!` because Button sizes every icon to 16px. */
  iconClass?: string
}

export interface TodoActionRunners {
  start: (todo: TodoView) => void
  setStatus: (todo: TodoView, status: 'done' | 'archived') => void
}

function failed(error: unknown) {
  toast.error(error instanceof Error ? error.message : 'Something went wrong')
}

/** The mutations behind the card actions, with failures surfaced as toasts. */
export function useTodoActionRunners(): TodoActionRunners {
  const startTodo = useStartTodo()
  const setTodoStatus = useSetTodoStatus()
  return useMemo(() => ({
    // useStartTodo reports its own failures.
    start: (todo) => startTodo.mutate(todo),
    setStatus: (todo, status) => setTodoStatus.mutate({ id: todo.id, status }, { onError: failed }),
  // The mutate functions are stable; the mutation objects are not.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [startTodo.mutate, setTodoStatus.mutate])
}

/**
 * The one action an item offers for where it is: start a draft, finish work
 * in flight, archive what is done. Archived items have none. A draft with
 * no agent yet opens instead, since starting needs one.
 */
export function cardActionFor(
  todo: TodoView | undefined,
  runners: TodoActionRunners,
  open: (todo: TodoView) => void,
): TodoCardAction | null {
  if (!todo) return null
  switch (todo.column) {
    case 'drafts':
      return {
        label: todo.agentSlug ? 'Start' : 'Pick an agent to start',
        Icon: Play,
        iconClass: '!h-3.5 !w-3.5 fill-current',
        kind: 'start',
        shortcut: 'S',
        testId: 'todo-action-start',
        run: () => (todo.agentSlug ? runners.start(todo) : open(todo)),
      }
    case 'working':
    case 'needs_input':
    case 'has_updates':
      return { label: 'Mark done', Icon: Check, kind: 'done', shortcut: 'D', testId: 'todo-action-done', run: () => runners.setStatus(todo, 'done') }
    case 'done':
      return { label: 'Archive', Icon: Archive, kind: 'archive', shortcut: 'E', testId: 'todo-action-archive', run: () => runners.setStatus(todo, 'archived') }
    case 'archived':
      return null
  }
}
