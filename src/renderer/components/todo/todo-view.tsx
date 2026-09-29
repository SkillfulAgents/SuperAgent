import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ChevronsRight, SquarePen } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import type { TodoCard } from './todo-schema'
import { todoActions, useTodoBoard } from './todo-store'
import { TodoBoardCard } from './todo-board-card'
import { TodoDraftDialog } from './todo-draft-dialog'
import { useSimulatedAgents } from './use-simulated-agents'
import { useAssignableAgents } from './todo-shared'
import { cardActionFor } from './todo-card-action'
import { ShortcutTooltip, ShortcutsDialog, usePlainKeys } from './todo-shortcuts'

// Whether Done was open, so coming back from an item's page keeps it.
let doneOpenMemo = false


const byNewest = (a: TodoCard, b: TodoCard) => b.updatedAt - a.updatedAt

function Column({ label, dot, count, action, className, children, testId }: {
  label: string
  dot: string
  count: number
  action?: ReactNode
  className?: string
  children: ReactNode
  testId: string
}) {
  return (
    <section
      aria-label={label}
      className={cn('flex min-h-0 min-w-0 flex-col rounded-xl bg-muted/50', className)}
      data-testid={testId}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 px-3">
        <span className={cn('h-2 w-2 rounded-full', dot)} />
        <h2 className="text-sm font-medium">{label}</h2>
        <span className="rounded-full bg-background px-1.5 text-[11px] text-muted-foreground">{count}</span>
        {action && <div className="ml-auto flex items-center gap-1">{action}</div>}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">{children}</div>
    </section>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="m-1 rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
      {children}
    </p>
  )
}

const EASE = 'ease-[cubic-bezier(0.32,0.72,0,1)]'

/**
 * Done, which folds into a thin strip. It is one column in both states so the
 * change can animate: the width grows or shrinks, and the header — dot,
 * label, count — pivots 90° about the green dot, reading down the strip when
 * folded and swinging up level when open. The count turns back the other way
 * so its number stays upright. Cards fade in once there is room for them.
 */
function DoneColumn({ open, view, doneCount, archivedCount, onOpen, onCollapse, onView, actions, children }: {
  open: boolean
  /** Which list the open column shows: Done, or the Archive behind it. */
  view: 'done' | 'archive'
  doneCount: number
  archivedCount: number
  onOpen: () => void
  onCollapse: () => void
  onView: (view: 'done' | 'archive') => void
  actions: ReactNode
  children: ReactNode
}) {
  const archived = view === 'archive'
  // The same segmented control as Settings → Appearance, with text for icons.
  const toggleItem = (active: boolean) =>
    cn(
      'inline-flex h-7 items-center justify-center rounded-md px-2.5 text-xs font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      active ? 'bg-background text-foreground shadow' : 'hover:text-foreground',
    )

  return (
    <section
      aria-label="Done"
      className={cn(
        'relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-muted/50 transition-[flex-grow,flex-basis,background-color] duration-300 motion-reduce:transition-none',
        EASE,
        open ? 'grow basis-0' : 'shrink-0 grow-0 basis-11 hover:bg-muted/70',
      )}
      data-testid={open ? 'todo-column-done' : 'todo-done-sliver'}
    >
      {/* Open, a click on the column's empty space folds it. This sits behind
          the header and list, which let clicks through except on buttons and
          cards. Keyboard users have the explicit collapse button. */}
      {open && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={onCollapse}
          title="Collapse"
          className="absolute inset-0 cursor-default rounded-xl"
          data-testid="todo-done-backdrop"
        />
      )}

      <header className="pointer-events-none relative flex h-12 shrink-0 items-center gap-2 whitespace-nowrap px-3 [&_button]:pointer-events-auto">
        {/* The pivot: the dot's centre is 4px in. Folded, a 6px nudge centres
            the dot in the 44px strip before the turn. */}
        <div
          className={cn('flex items-center gap-2 transition-transform duration-300 motion-reduce:transition-none', EASE)}
          style={{ transformOrigin: '4px 50%', transform: open ? 'none' : 'translateX(6px) rotate(90deg)' }}
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
          {/* Both states share one spot: the plain label rides the swing and the
              switch takes its place once open (and leaves first on the way back). */}
          <div className="grid items-center [&>*]:[grid-area:1/1]">
            <div
              className={cn('flex items-center gap-2 transition-opacity duration-150 motion-reduce:transition-none', open ? 'opacity-0 delay-100' : 'opacity-100')}
              aria-hidden={open}
            >
              <h2 className="text-sm font-medium">Done</h2>
              <span
                className={cn('rounded-full bg-background px-1.5 text-[11px] text-muted-foreground transition-transform duration-300 motion-reduce:transition-none', EASE)}
                style={{ transform: open ? 'none' : 'rotate(-90deg)' }}
              >
                {doneCount}
              </span>
            </div>
            <div
              role="radiogroup"
              aria-label="Show"
              aria-hidden={!open}
              className={cn(
                'inline-flex h-8 items-center justify-start justify-self-start rounded-lg bg-muted p-0.5 text-muted-foreground transition-opacity duration-150 motion-reduce:transition-none',
                open ? 'opacity-100 delay-150' : 'pointer-events-none opacity-0',
              )}
            >
            <button
              type="button"
              role="radio"
              onClick={() => onView('done')}
              aria-checked={!archived}
              tabIndex={open ? undefined : -1}
              className={toggleItem(!archived)}
              data-testid="todo-done-tab"
            >
              Done
              <span className="ml-1.5 tabular-nums text-muted-foreground">{doneCount}</span>
            </button>
            <button
              type="button"
              role="radio"
              onClick={() => onView('archive')}
              aria-checked={archived}
              tabIndex={open ? undefined : -1}
              className={toggleItem(archived)}
              data-testid="todo-archive-tab"
            >
              Archived
              <span className="ml-1.5 tabular-nums text-muted-foreground">{archivedCount}</span>
            </button>
            </div>
          </div>
        </div>

        <div
          className={cn(
            'ml-auto flex items-center gap-1.5 transition-opacity duration-200 motion-reduce:transition-none',
            open ? 'opacity-100 delay-150' : 'pointer-events-none opacity-0',
          )}
          aria-hidden={!open}
        >
          {actions}
        </div>
      </header>

      <div
        className={cn(
          'pointer-events-none relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 transition-opacity duration-200 motion-reduce:transition-none [&>*]:pointer-events-auto',
          open ? 'opacity-100 delay-150' : 'invisible opacity-0',
        )}
      >
        {children}
      </div>

      {!open && (
        <button
          type="button"
          onClick={onOpen}
          className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={`Show Done, ${doneCount} items`}
          title="Show Done"
        />
      )}
    </section>
  )
}

/**
 * The work board. Three columns carry the day — Drafts, Needs you, Working —
 * and Done folds into a sliver. A card opens its session page (a draft opens
 * its dialog); nothing is actioned from the board itself.
 */
export function TodoView() {
  const board = useTodoBoard()
  const navigate = useNavigate()
  useSimulatedAgents(board.cards)

  const [doneOpen, setDoneOpenState] = useState(doneOpenMemo)
  const setDoneOpen = (open: boolean) => {
    doneOpenMemo = open
    setDoneOpenState(open)
  }
  const [showArchived, setShowArchived] = useState(false)
  const [draft, setDraft] = useState<{ id: string; isNew: boolean } | null>(null)
  // The card shortcuts act on. Arrow keys move it; hovering a card sets it.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const agents = useAssignableAgents()
  // "G" starts a two-key sequence (G then D shows or hides Done).
  const gPressedAt = useRef(0)

  const columns = useMemo(() => {
    const of = (column: TodoCard['column']) => board.cards.filter((c) => c.column === column)
    const attention = of('attention')
    return {
      drafts: of('drafts').sort(byNewest),
      // Blocked before review: a blocked agent is idle until you act.
      attention: [
        ...attention.filter((c) => c.attentionReason !== 'review').sort(byNewest),
        ...attention.filter((c) => c.attentionReason === 'review').sort(byNewest),
      ],
      working: of('working').sort(byNewest),
      done: of('done').sort(byNewest),
      archive: of('archive').sort(byNewest),
    }
  }, [board.cards])

  const open = useCallback((card: TodoCard) => {
    if (card.column === 'drafts') setDraft({ id: card.id, isNew: false })
    else void navigate({ to: '/todo/$itemId', params: { itemId: card.id } })
  }, [navigate])
  const newDraft = () => setDraft({ id: todoActions.createDraft('').id, isNew: true })
  const closeDraft = useCallback(() => {
    setDraft((current) => {
      if (current) todoActions.discardIfEmpty(current.id)
      return null
    })
  }, [])

  const collapseDone = () => {
    setDoneOpen(false)
    setShowArchived(false)
  }

  // The columns in order, as the keyboard walks them. Done joins only when open.
  const finishedList = showArchived ? columns.archive : columns.done
  const lanes = [columns.drafts, columns.attention, columns.working, ...(doneOpen ? [finishedList] : [])]
  const locate = (id: string | null) => {
    if (!id) return null
    for (let lane = 0; lane < lanes.length; lane++) {
      const row = lanes[lane].findIndex((c) => c.id === id)
      if (row !== -1) return { lane, row }
    }
    return null
  }

  const select = (card: TodoCard | undefined) => {
    if (!card) return
    setSelectedId(card.id)
    requestAnimationFrame(() => {
      document.querySelector(`[data-card-id="${card.id}"]`)?.scrollIntoView({ block: 'nearest' })
    })
  }

  usePlainKeys((event) => {
    const key = event.key
    const at = locate(selectedId)

    if (key === '?') {
      setShortcutsOpen(true)
      return true
    }
    if (key === 'Escape') {
      if (!selectedId) return false
      setSelectedId(null)
      return true
    }
    if (key === 'g' || key === 'G') {
      gPressedAt.current = Date.now()
      return true
    }
    if ((key === 'd' || key === 'D') && Date.now() - gPressedAt.current < 1000) {
      gPressedAt.current = 0
      if (doneOpen) collapseDone()
      else setDoneOpen(true)
      return true
    }
    if (key === 'c' || key === 'C') {
      newDraft()
      return true
    }

    const vertical = key === 'j' || key === 'ArrowDown' ? 1 : key === 'k' || key === 'ArrowUp' ? -1 : 0
    const horizontal = key === 'l' || key === 'ArrowRight' ? 1 : key === 'h' || key === 'ArrowLeft' ? -1 : 0
    if (vertical || horizontal) {
      if (!at) {
        // Nothing selected yet: start where attention is needed, else the first card.
        select(columns.attention[0] ?? lanes.find((l) => l.length > 0)?.[0])
        return true
      }
      if (vertical) {
        select(lanes[at.lane][Math.min(Math.max(at.row + vertical, 0), lanes[at.lane].length - 1)])
        return true
      }
      // Sideways: the next column that has cards, keeping the row where it can.
      // Walking right off Working opens Done.
      for (let lane = at.lane + horizontal; lane >= 0 && lane < 4; lane += horizontal) {
        const list = lane === 3 ? columns.done : lanes[lane]
        if (!list || list.length === 0) continue
        if (lane === 3 && !doneOpen) setDoneOpen(true)
        select(list[Math.min(at.row, list.length - 1)])
        return true
      }
      return true
    }

    const card = at ? lanes[at.lane][at.row] : undefined
    if (!card) return false
    if (key === 'Enter' || key === 'o' || key === 'O') {
      open(card)
      return true
    }
    const action = cardActionFor(card, agents)
    if (action && key.toUpperCase() === action.shortcut) {
      // The card leaves its column; keep the selection moving down it.
      const list = lanes[at!.lane]
      const next = list[at!.row + 1] ?? list[at!.row - 1]
      action.run()
      setSelectedId(next?.id ?? null)
      return true
    }
    return false
  }, !draft && !shortcutsOpen)

  const cards = (list: TodoCard[]) =>
    list.map((card) => (
      <TodoBoardCard key={card.id} card={card} onOpen={open} selected={card.id === selectedId} onHover={(c) => setSelectedId(c.id)} />
    ))

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="todo-view">
      <div className="min-h-0 flex-1 overflow-x-auto p-6">
        <div className="flex h-full min-w-[820px] gap-3">
          <Column
            label="Drafts"
            dot="bg-muted-foreground/40"
            count={columns.drafts.length}
            className="flex-1"
            testId="todo-column-drafts"
            action={(
              <ShortcutTooltip label="New draft" keys={['C']}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground"
                  aria-label="New draft"
                  aria-keyshortcuts="C"
                  onClick={newDraft}
                  data-testid="todo-new-draft"
                >
                  <SquarePen className="h-4 w-4" />
                </Button>
              </ShortcutTooltip>
            )}
          >
            {columns.drafts.length > 0 ? cards(columns.drafts) : <Empty>Jot down what you want done. Start it when it is ready.</Empty>}
          </Column>

          <Column label="Needs you" dot="bg-orange-500" count={columns.attention.length} className="flex-1" testId="todo-column-attention">
            {columns.attention.length > 0 ? cards(columns.attention) : <Empty>Nothing is waiting on you.</Empty>}
          </Column>

          <Column label="Working" dot="bg-sky-500" count={columns.working.length} className="flex-1" testId="todo-column-working">
            {columns.working.length > 0 ? cards(columns.working) : <Empty>No agents are working on anything right now.</Empty>}
          </Column>

          <DoneColumn
            open={doneOpen}
            view={showArchived ? 'archive' : 'done'}
            doneCount={columns.done.length}
            archivedCount={columns.archive.length}
            onOpen={() => setDoneOpen(true)}
            onCollapse={collapseDone}
            onView={(v) => setShowArchived(v === 'archive')}
            actions={(
              <>
                <ShortcutTooltip label="Hide Done" keys={['G', 'D']}>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    aria-label="Collapse Done"
                    onClick={collapseDone}
                    tabIndex={doneOpen ? undefined : -1}
                  >
                    <ChevronsRight className="h-3.5 w-3.5" />
                  </Button>
                </ShortcutTooltip>
              </>
            )}
          >
            {finishedList.length > 0 ? cards(finishedList) : <Empty>{showArchived ? 'Nothing archived.' : 'Nothing finished yet.'}</Empty>}
          </DoneColumn>
        </div>
      </div>

      <TodoDraftDialog cardId={draft?.id ?? null} isNew={draft?.isNew} onClose={closeDraft} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  )
}
