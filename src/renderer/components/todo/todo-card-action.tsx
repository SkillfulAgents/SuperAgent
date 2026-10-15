import { useMemo } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Archive, ArchiveRestore, Check, Play } from 'lucide-react'
import { todoUnarchiveStatus, type TodoStatusChange } from '@shared/lib/todos/todo-schema'
import { useSetTodoStatus, useStartTodo, type TodoView } from '@renderer/hooks/use-todos'

export interface TodoCardAction {
  label: string
  Icon: LucideIcon
  run: () => void
  /** What the action does to the item. */
  kind: 'start' | 'done' | 'archive' | 'unarchive'
  /** Its single-key shortcut, the same wherever the item shows it. */
  shortcut: 'S' | 'D' | 'E' | 'U'
  testId: string
  /** Extra icon classes: Play is drawn filled and a step smaller. `!` because Button sizes every icon to 16px. */
  iconClass?: string
}

export interface TodoActionRunners {
  start: (todo: TodoView) => void
  setStatus: (todo: TodoView, status: TodoStatusChange) => void
}

/** The mutations behind the card actions. Each reports its own failures. */
export function useTodoActionRunners(): TodoActionRunners {
  const startTodo = useStartTodo()
  const setTodoStatus = useSetTodoStatus()
  return useMemo(() => ({
    start: (todo) => startTodo.mutate(todo),
    setStatus: (todo, status) => setTodoStatus.mutate({ id: todo.id, status }),
  // The mutate functions are stable; the mutation objects are not.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [startTodo.mutate, setTodoStatus.mutate])
}

/**
 * The one action an item's card offers for where it is: start a draft,
 * finish work in flight, archive what is done, unarchive what is archived.
 * A draft with no agent (or new agent) yet opens instead, since starting needs one.
 */
export function cardActionFor(
  todo: TodoView | undefined,
  runners: TodoActionRunners,
  open: (todo: TodoView) => void,
): TodoCardAction | null {
  if (!todo) return null
  switch (todo.column) {
    case 'drafts': {
      const startable = !!todo.agentSlug || todo.newAgent
      return {
        label: startable ? 'Start' : 'Pick an agent to start',
        Icon: Play,
        iconClass: '!h-3.5 !w-3.5 fill-current',
        kind: 'start',
        shortcut: 'S',
        testId: 'todo-action-start',
        run: () => (startable ? runners.start(todo) : open(todo)),
      }
    }
    case 'working':
    case 'needs_input':
    case 'has_updates':
      return { label: 'Mark done', Icon: Check, kind: 'done', shortcut: 'D', testId: 'todo-action-done', run: () => runners.setStatus(todo, 'done') }
    case 'done':
      return { label: 'Archive', Icon: Archive, kind: 'archive', shortcut: 'E', testId: 'todo-action-archive', run: () => runners.setStatus(todo, 'archived') }
    case 'archived':
      return {
        label: 'Unarchive',
        Icon: ArchiveRestore,
        kind: 'unarchive',
        shortcut: 'U',
        testId: 'todo-action-unarchive',
        run: () => runners.setStatus(todo, todoUnarchiveStatus(todo)),
      }
  }
}

/**
 * Archiving a draft: not the card's one action (that is Start), so it is
 * offered by the E shortcut and in the draft dialog instead.
 */
export function archiveDraftAction(todo: TodoView | undefined, runners: TodoActionRunners): TodoCardAction | null {
  if (todo?.column !== 'drafts') return null
  return { label: 'Archive', Icon: Archive, kind: 'archive', shortcut: 'E', testId: 'todo-action-archive', run: () => runners.setStatus(todo, 'archived') }
}
