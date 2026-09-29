import type { LucideIcon } from 'lucide-react'
import { Archive, Check, Play } from 'lucide-react'
import type { TodoAgentRef, TodoCard } from './todo-schema'
import { todoActions } from './todo-store'
import { pickAgentFor, useAssignableAgents } from './todo-shared'

export interface TodoCardAction {
  label: string
  Icon: LucideIcon
  run: () => void
  /** What the action leaves behind: archived items leave the board. */
  kind: 'start' | 'done' | 'archive'
  /** Its single-key shortcut, the same on the board and the session page. */
  shortcut: 'S' | 'D' | 'E'
  testId: string
  /** Extra icon classes: Play is drawn filled and a step smaller. `!` because Button sizes every icon to 16px. */
  iconClass?: string
}

/**
 * The one action an item offers for its state — the same on its board card
 * and in the top right of its session page: start a draft, finish work in
 * flight (approve, for a review), archive what is done. Archived items have
 * none.
 */
export function useCardAction(card: TodoCard | undefined): TodoCardAction | null {
  return cardActionFor(card, useAssignableAgents())
}

/** The same, outside a component — for keyboard shortcuts acting on a selection. */
export function cardActionFor(card: TodoCard | undefined, agents: TodoAgentRef[]): TodoCardAction | null {
  if (!card) return null
  switch (card.column) {
    case 'drafts':
      return { label: 'Start', Icon: Play, iconClass: '!h-3.5 !w-3.5 fill-current', kind: 'start', shortcut: 'S', testId: 'todo-action-start', run: () => todoActions.start(card.id, pickAgentFor(card.prompt, agents)) }
    case 'attention':
    case 'working': {
      const review = card.column === 'attention' && card.attentionReason === 'review'
      return {
        label: review ? 'Approve' : 'Mark done',
        Icon: Check,
        kind: 'done',
        shortcut: 'D',
        testId: 'todo-action-done',
        run: () => todoActions.markDone(card.id, review ? 'Approved by you.' : 'Marked done by you.'),
      }
    }
    case 'done':
      return { label: 'Archive', Icon: Archive, kind: 'archive', shortcut: 'E', testId: 'todo-action-archive', run: () => todoActions.move(card.id, 'archive') }
    case 'archive':
      return null
  }
}
