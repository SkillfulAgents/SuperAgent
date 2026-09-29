import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { format, isToday } from 'date-fns'
import { ArrowDown, ArrowLeft, ArrowUp } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { Markdown } from '@renderer/components/ui/markdown'
import { FileIconTile } from '@renderer/components/ui/file-icon-tile'
import { ChatComposerBox, FLOATING_COMPOSER_CLASS } from '@renderer/components/messages/chat-composer-box'
import { QuestionRequestItem } from '@renderer/components/messages/question-request-item'
import type { TodoCard } from './todo-schema'
import { todoActions, useTodoBoard, useTodoCard } from './todo-store'
import { useCardAction } from './todo-card-action'
import { ShortcutTooltip, usePlainKeys } from './todo-shortcuts'
import { TodoAgentAvatar, relativeTime } from './todo-shared'
import { TodoRequestCard } from './todo-request-card'
import { useSimulatedAgents } from './use-simulated-agents'

/*
 * The item page: a preview of the work's session, opened from the list with a
 * back button to return. Prototype: the transcript is drawn from the item's
 * own fields rather than a real session, but it uses the session's bubble
 * styles, and the bottom slot is the session's real request cards or its
 * composer — exactly where a session puts them.
 */

// Same prose surface and bubble recipe as the session's message item.
const PROSE_CLASS = 'prose prose-sm max-w-none min-w-0 break-words font-normal dark:prose-invert prose-strong:font-medium'
const USER_BUBBLE_CLASS = 'rounded-lg bg-zinc-100 px-4 py-2 text-foreground dark:bg-zinc-800/70'

function when(ts: number): string {
  if (Date.now() - ts < 60_000) return 'Just now'
  return isToday(ts) ? relativeTime(ts) : format(ts, 'MMM d')
}

function sourceLabel(card: TodoCard): string {
  if (card.source === 'recurring') return card.schedule ?? 'Recurring'
  if (card.source === 'conversation') return 'Conversation'
  return 'Task'
}

const goToList = { to: '/todo' } as const

/**
 * Everything waiting on the user, in the order the list shows it: Blocked
 * first (an idle agent), then Review, newest first within each.
 */
function attentionQueue(cards: TodoCard[]): TodoCard[] {
  const byNewest = (a: TodoCard, b: TodoCard) => b.updatedAt - a.updatedAt
  const waiting = cards.filter((c) => c.column === 'attention')
  return [
    ...waiting.filter((c) => c.attentionReason !== 'review').sort(byNewest),
    ...waiting.filter((c) => c.attentionReason === 'review').sort(byNewest),
  ]
}

/** Where this item sits in the attention queue, and its neighbours. */
function useQueuePosition(itemId: string) {
  const queue = attentionQueue(useTodoBoard().cards)
  const index = queue.findIndex((c) => c.id === itemId)
  return {
    queue,
    index,
    prev: index > 0 ? queue[index - 1] : null,
    // From an item outside the queue (say, one that is running), down enters it at the top.
    next: index === -1 ? (queue[0] ?? null) : (queue[index + 1] ?? null),
  }
}

/** Down/up through everything waiting on you, like Linear's issue stepper. */
function QueueStepper({ position, go }: { position: ReturnType<typeof useQueuePosition>; go: (card: TodoCard | null) => void }) {
  const { queue, index, prev, next } = position
  if (queue.length === 0) return null
  return (
    <div className="app-no-drag flex shrink-0 items-center gap-2" data-testid="todo-item-stepper">
      <span className="text-xs tabular-nums text-muted-foreground">
        {index === -1 ? `${queue.length} waiting` : `${index + 1} / ${queue.length}`}
      </span>
      {/* One split control: down and up share a border. */}
      <div className="flex items-center">
        <ShortcutTooltip label="Navigate down" keys={['J']}>
          <Button variant="outline" size="icon" className="h-8 w-8 rounded-r-none text-muted-foreground" disabled={!next} onClick={() => go(next)} aria-label="Next item needing attention" aria-keyshortcuts="J">
            <ArrowDown className="h-4 w-4" />
          </Button>
        </ShortcutTooltip>
        <ShortcutTooltip label="Navigate up" keys={['K']}>
          <Button variant="outline" size="icon" className="-ml-px h-8 w-8 rounded-l-none text-muted-foreground" disabled={!prev} onClick={() => go(prev)} aria-label="Previous item needing attention" aria-keyshortcuts="K">
            <ArrowUp className="h-4 w-4" />
          </Button>
        </ShortcutTooltip>
      </div>
    </div>
  )
}

/** Left side of the content header: back, then the item's title and metadata. */
export function TodoItemHeader({ itemId }: { itemId: string }) {
  const card = useTodoCard(itemId)
  const navigate = useNavigate()
  // The same action the item's board card shows on hover.
  const action = useCardAction(card)
  const position = useQueuePosition(itemId)
  const go = (target: TodoCard | null) => target && void navigate({ to: '/todo/$itemId', params: { itemId: target.id } })
  const back = () => void navigate(goToList)
  const runAction = () => {
    if (!action) return
    action.run()
    // Archiving takes it off the board, so return there; otherwise stay
    // and let the page show its new state.
    if (action.kind === 'archive') back()
  }

  usePlainKeys((event) => {
    const key = event.key
    if (key === 'Escape') { back(); return true }
    if (key === 'j' || key === 'J') { go(position.next); return true }
    if (key === 'k' || key === 'K') { go(position.prev); return true }
    if (action && key.toUpperCase() === action.shortcut) { runAction(); return true }
    return false
  })

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <ShortcutTooltip label="Back to board" keys={['Esc']}>
        <Button
          variant="outline"
          size="icon"
          className="app-no-drag h-8 w-8 shrink-0 text-muted-foreground"
          aria-label="Back to board"
          aria-keyshortcuts="Escape"
          onClick={back}
          data-testid="todo-item-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
      </ShortcutTooltip>

      {card && (
        <>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm leading-tight text-foreground">{card.title.trim() || 'Untitled task'}</p>
            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {card.agents[0] && <TodoAgentAvatar agent={card.agents[0]} size={14} />}
              <span className="truncate">
                {[card.agents.map((a) => a.name).join(' & ') || undefined, when(card.updatedAt), sourceLabel(card)].filter(Boolean).join(' · ')}
              </span>
            </p>
          </div>

        </>
      )}
      {/* Step through everything waiting on you, then the item's action at the far right. */}
      <QueueStepper position={position} go={go} />
      {action && (
        <ShortcutTooltip label={action.label} keys={[action.shortcut]}>
          <Button
            variant="outline"
            size="icon"
            className="app-no-drag h-8 w-8 shrink-0 text-muted-foreground"
            aria-label={action.label}
            aria-keyshortcuts={action.shortcut}
            onClick={runAction}
            data-testid={action.testId}
          >
            <action.Icon className={cn('h-4 w-4', action.iconClass)} />
          </Button>
        </ShortcutTooltip>
      )}
    </div>
  )
}

function AgentLine({ card }: { card: TodoCard }) {
  const agent = card.agents[0]
  if (!agent) return null
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
      <TodoAgentAvatar agent={agent} size={18} />
      <span>{card.agents.map((a) => a.name).join(' & ')}</span>
    </div>
  )
}

/** The mock transcript: the brief, then the agent's latest word or live status. */
function Transcript({ card }: { card: TodoCard }) {
  // A reply the user just sent is stored as "You: …"; show it as their bubble.
  const userReply = card.lastUpdate?.startsWith('You: ') ? card.lastUpdate.slice(5) : null
  const agentText = userReply ? null : card.lastUpdate

  return (
    <div className="space-y-6">
      {/* The brief, as the opening user message */}
      <div className="flex flex-col items-end gap-2">
        <div className={cn('max-w-[80%]', USER_BUBBLE_CLASS)}>
          <div className={PROSE_CLASS}>
            <Markdown>{card.prompt || '*No description*'}</Markdown>
          </div>
        </div>
        {card.attachments.length > 0 && (
          <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
            {card.attachments.map((a) => (
              <span key={a.id} className="inline-flex items-center gap-1.5 rounded-md border bg-background py-1 pl-1 pr-2 text-xs">
                <FileIconTile filename={a.name} folder={a.kind === 'folder'} className="h-5 w-5 text-[8px]" />
                {a.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* What the agent said last */}
      {agentText && card.column !== 'working' && (
        <div>
          <AgentLine card={card} />
          <div className={cn('py-1', PROSE_CLASS)}>
            <Markdown>{agentText}</Markdown>
          </div>
        </div>
      )}

      {/* The user's latest reply */}
      {userReply && (
        <div className="flex justify-end">
          <div className={cn('max-w-[80%]', USER_BUBBLE_CLASS)}>
            <div className={PROSE_CLASS}>
              <p>{userReply}</p>
            </div>
          </div>
        </div>
      )}

      {/* Live status while the agent works */}
      {card.column === 'working' && (
        <div>
          <AgentLine card={card} />
          <p className="todo-shimmer text-sm" data-testid="todo-item-status">
            {userReply ? 'Working…' : (card.lastUpdate ?? 'Working…')}
          </p>
        </div>
      )}
    </div>
  )
}

/** Where a session puts it: the pending request card, else the composer. */
function BottomSlot({ card }: { card: TodoCard }) {
  const navigate = useNavigate()
  const [value, setValue] = useState('')
  const agentName = card.agents[0]?.name ?? 'the agent'

  if (card.column === 'archive') return null

  if (card.column === 'attention' && card.attentionReason === 'question' && card.questions?.length) {
    return (
      <QuestionRequestItem
        toolUseId={card.id}
        questions={card.questions.map((q) => ({
          question: q.question,
          header: q.header ?? '',
          multiSelect: q.multiSelect ?? false,
          options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? '' })),
        }))}
        onAnswer={(answer) => {
          const summary = 'answers' in answer ? Object.values(answer.answers).join(' · ') : `Skipped: ${answer.declineReason}`
          todoActions.resume(card.id, summary)
        }}
        onComplete={() => {}}
      />
    )
  }

  if (card.column === 'attention' && card.request) {
    return <TodoRequestCard card={card} />
  }

  const send = () => {
    const text = value.trim()
    if (!text) return
    todoActions.resume(card.id, text)
    setValue('')
  }
  const placeholder =
    card.column === 'attention' && card.attentionReason === 'question'
      ? `Answer ${agentName}…`
      : card.column === 'attention'
        ? 'Request changes or ask a question'
        : card.column === 'working'
          ? `Add a message for ${agentName}…`
          : 'Follow up…'

  return (
    <ChatComposerBox
      className={FLOATING_COMPOSER_CLASS}
      attachments={[]}
      onRemoveAttachment={() => {}}
      value={value}
      onChange={setValue}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          send()
        }
      }}
      placeholder={placeholder}
      rows={1}
      dataTestId="todo-item-composer"
      rightActions={(
        <>
          {card.column === 'working' && (
            <Button
              variant="outline"
              size="icon"
              className="h-[34px] w-[34px]"
              aria-label="Stop"
              title="Stop"
              onClick={() => {
                todoActions.stop(card.id)
                void navigate(goToList)
              }}
            >
              <span className="h-3 w-3 rounded-[2px] bg-foreground" />
            </Button>
          )}
          <Button size="icon" className="h-[34px] w-[34px]" disabled={!value.trim()} onClick={send} aria-label="Send" title="Send (↩)">
            <ArrowUp className="h-4 w-4" />
          </Button>
        </>
      )}
    />
  )
}

/** The page body: the transcript scrolls; the request card or composer stays put. */
export function TodoItemPage({ itemId }: { itemId: string }) {
  const card = useTodoCard(itemId)
  const navigate = useNavigate()
  useSimulatedAgents(useTodoBoard().cards)

  if (!card) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        This item no longer exists.
        <Button variant="outline" size="sm" onClick={() => void navigate(goToList)}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="todo-item-page">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-4 py-8">
          <Transcript card={card} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-[740px] shrink-0 px-4 pb-4">
        <BottomSlot key={`${card.column}-${card.attentionReason ?? ''}`} card={card} />
      </div>
    </div>
  )
}
