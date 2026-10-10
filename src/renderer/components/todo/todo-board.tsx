import { Fragment, useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import { ChevronsRight, SquarePen } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { byBoardOrder, positionAfterDrop, type TodoColumn } from '@shared/lib/todos/todo-schema'
import { Button } from '@renderer/components/ui/button'
import { useMoveTodo, useStartingTodoIds, useTodos, type TodoView } from '@renderer/hooks/use-todos'
import { TodoBoardCard } from './todo-board-card'
import { TodoCardMenu, TodoRenameDialog } from './todo-card-menu'
import { TodoDraftDialog, type TodoDraftTarget } from './todo-draft-dialog'
import { archiveDraftAction, cardActionFor, useTodoActionRunners } from './todo-card-action'
import { ShortcutTooltip, ShortcutsDialog, usePlainKeys } from './todo-shortcuts'
import { useTodoAgents } from './todo-shared'

// Whether Done was open, so coming back from a session keeps it.
let doneOpenMemo = false

// Hoisted: useSensor memoizes on the options object (see app-sidebar.tsx).
// The distance keeps a click on a card a click.
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 5 } }

/** Cards reorder within their own column only: other columns are not drop targets. */
const sameColumnOnly: CollisionDetection = (args) =>
  closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (container) => container.data.current?.column === args.active.data.current?.column,
    ),
  })

/** A card that can be dragged up or down its column. */
function SortableCard({ todo, children }: { todo: TodoView; children: ReactNode }) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: todo.id,
    data: { column: todo.column },
  })
  return (
    <div
      ref={setNodeRef}
      // Translate only: Transform would also scale the card to the size of
      // the one it's over, stretching cards of different heights.
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && 'relative z-10 opacity-80')}
      data-testid="todo-sortable"
      {...listeners}
    >
      {children}
    </div>
  )
}

function Column({ label, dot, count, action, children, testId }: {
  label: string
  dot: string
  count: number
  action?: ReactNode
  children: ReactNode
  testId: string
}) {
  return (
    <section
      aria-label={label}
      className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl bg-muted/50"
      data-testid={testId}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 px-3">
        <span className={cn('h-2 w-2 rounded-full', dot)} />
        <h2 className="truncate text-sm font-medium">{label}</h2>
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
function DoneColumn({ open, view, doneCount, archivedCount, onOpen, onCollapse, onView, children }: {
  open: boolean
  /** Which list the open column shows: Done, or the Archive behind it. */
  view: 'done' | 'archived'
  doneCount: number
  archivedCount: number
  onOpen: () => void
  onCollapse: () => void
  onView: (view: 'done' | 'archived') => void
  children: ReactNode
}) {
  const archived = view === 'archived'
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
                onClick={() => onView('archived')}
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
          <ShortcutTooltip label="Hide Done" keys={['G', 'D']}>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              aria-label="Collapse Done"
              onClick={onCollapse}
              tabIndex={open ? undefined : -1}
            >
              <ChevronsRight className="h-3.5 w-3.5" />
            </Button>
          </ShortcutTooltip>
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
 * The open columns, in board order. Done and Archived share the folding
 * column. Needs you holds everything waiting on the person: blocked work
 * (needs input) first, then work with updates to look at. Each group is
 * ordered, and dragged, on its own.
 */
const LANES = [
  { id: 'drafts', columns: ['drafts'], label: 'Drafts', dot: 'bg-muted-foreground/40', empty: 'Write down what you want done. Start it when it is ready.' },
  { id: 'needs_you', columns: ['needs_input', 'has_updates'], label: 'Needs you', dot: 'bg-orange-500', empty: 'Nothing is waiting on you.' },
  { id: 'working', columns: ['working'], label: 'Working', dot: 'bg-sky-500', empty: 'No agents are working on anything right now.' },
] as const satisfies readonly { id: string; columns: readonly TodoColumn[]; label: string; dot: string; empty: string }[]

/**
 * The Todo board. Drafts, then what needs you (blocked work, then work
 * with updates to look at), then what agents are working on, and Done
 * folded to the side.
 * A draft opens its dialog; anything started opens its session.
 */
export function TodoBoard() {
  const { data: todos, isPending, error } = useTodos()
  const navigate = useNavigate()
  const { bySlug } = useTodoAgents()
  const runners = useTodoActionRunners()
  const starting = useStartingTodoIds()
  const moveTodo = useMoveTodo()
  const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS))

  const [doneOpen, setDoneOpenState] = useState(doneOpenMemo)
  const setDoneOpen = (open: boolean) => {
    doneOpenMemo = open
    setDoneOpenState(open)
  }
  const [showArchived, setShowArchived] = useState(false)
  const [draft, setDraft] = useState<TodoDraftTarget | null>(null)
  const [renaming, setRenaming] = useState<TodoView | null>(null)
  // The card shortcuts act on. Arrow keys move it; hovering a card sets it.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // "G" starts a two-key sequence (G then D shows or hides Done).
  const gPressedAt = useRef(0)

  const columns = useMemo(() => {
    const of = (column: TodoColumn) => (todos ?? []).filter((t) => t.column === column).sort(byBoardOrder)
    return {
      drafts: of('drafts'),
      working: of('working'),
      needs_input: of('needs_input'),
      has_updates: of('has_updates'),
      done: of('done'),
      archived: of('archived'),
    } satisfies Record<TodoColumn, TodoView[]>
  }, [todos])

  const open = useCallback((todo: TodoView) => {
    if (todo.column === 'drafts') {
      setDraft({ kind: 'existing', todo })
    } else if (todo.agentSlug && todo.sessionId) {
      void navigate({ to: '/agents/$slug/sessions/$sessionId', params: { slug: todo.agentSlug, sessionId: todo.sessionId } })
    }
  }, [navigate])
  const newDraft = () => setDraft({ kind: 'new' })
  const closeDraft = useCallback(() => setDraft(null), [])

  const collapseDone = () => {
    setDoneOpen(false)
    setShowArchived(false)
  }

  // The columns in order, as the keyboard walks them. Done joins only when open.
  const finishedList = showArchived ? columns.archived : columns.done
  const laneCards = (lane: (typeof LANES)[number]) => lane.columns.flatMap((column) => columns[column])
  const lanes = [...LANES.map(laneCards), ...(doneOpen ? [finishedList] : [])]
  const locate = (id: string | null) => {
    if (!id) return null
    for (let lane = 0; lane < lanes.length; lane++) {
      const row = lanes[lane].findIndex((t) => t.id === id)
      if (row !== -1) return { lane, row }
    }
    return null
  }

  const select = (todo: TodoView | undefined) => {
    if (!todo) return
    setSelectedId(todo.id)
    requestAnimationFrame(() => {
      document.querySelector(`[data-todo-id="${todo.id}"]`)?.scrollIntoView({ block: 'nearest' })
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
        // Nothing selected yet: start where input is needed, else the first card.
        select(columns.needs_input[0] ?? lanes.find((l) => l.length > 0)?.[0])
        return true
      }
      if (vertical) {
        select(lanes[at.lane][Math.min(Math.max(at.row + vertical, 0), lanes[at.lane].length - 1)])
        return true
      }
      // Sideways: the next column that has cards, keeping the row where it can.
      // Walking right off the last open column opens Done.
      const doneLane = LANES.length
      for (let lane = at.lane + horizontal; lane >= 0 && lane <= doneLane; lane += horizontal) {
        // An open Done column walks whichever list it shows (Done or Archived).
        const list = lane === doneLane ? (doneOpen ? finishedList : columns.done) : lanes[lane]
        if (!list || list.length === 0) continue
        if (lane === doneLane && !doneOpen) setDoneOpen(true)
        select(list[Math.min(at.row, list.length - 1)])
        return true
      }
      return true
    }

    const todo = at ? lanes[at.lane][at.row] : undefined
    if (!todo || !at) return false
    if (key === 'Enter' || key === 'o' || key === 'O') {
      if (!starting.has(todo.id)) open(todo)
      return true
    }
    const action = [cardActionFor(todo, runners, open), archiveDraftAction(todo, runners)]
      .find((a) => a?.shortcut === key.toUpperCase())
    if (action && !starting.has(todo.id)) {
      // The card leaves its column; keep the selection moving down it.
      const list = lanes[at.lane]
      const next = list[at.row + 1] ?? list[at.row - 1]
      action.run()
      if (action.kind !== 'start' || todo.agentSlug || todo.newAgent) setSelectedId(next?.id ?? null)
      return true
    }
    return false
  }, !draft && !renaming && !shortcutsOpen)

  const cards = (list: TodoView[]) => (
    <SortableContext items={list.map((todo) => todo.id)} strategy={verticalListSortingStrategy}>
      {list.map((todo) => (
        <SortableCard key={todo.id} todo={todo}>
          <TodoCardMenu todo={todo} onRename={setRenaming}>
            <TodoBoardCard
              todo={todo}
              agent={todo.agentSlug ? bySlug.get(todo.agentSlug) : undefined}
              action={cardActionFor(todo, runners, open)}
              starting={starting.has(todo.id)}
              onOpen={open}
              selected={todo.id === selectedId}
              onHover={(t) => setSelectedId(t.id)}
            />
          </TodoCardMenu>
        </SortableCard>
      ))}
    </SortableContext>
  )

  // A drop puts the card between its new neighbours. Only its order changes.
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const column = active.data.current?.column as TodoColumn | undefined
    if (!column || over.data.current?.column !== column) return
    const position = positionAfterDrop(columns[column], String(active.id), String(over.id))
    if (position !== null) moveTodo.mutate({ id: String(active.id), position })
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground" data-testid="todo-board-error">
        Could not load your todos. {error.message}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="todo-board" aria-busy={isPending || undefined}>
      <div className="min-h-0 flex-1 overflow-x-auto p-6">
        <DndContext sensors={sensors} collisionDetection={sameColumnOnly} modifiers={[restrictToVerticalAxis]} onDragEnd={onDragEnd}>
          {/* The minimum fits the default window (1280 wide, sidebar at its
              288px minimum) with no horizontal scroll; narrower, it scrolls. */}
          <div className="flex h-full min-w-[896px] gap-3">
            {LANES.map((lane) => (
              <Column
                key={lane.id}
                label={lane.label}
                dot={lane.dot}
                count={laneCards(lane).length}
                testId={`todo-column-${lane.id}`}
                action={lane.id === 'drafts' ? (
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
                ) : undefined}
              >
                {laneCards(lane).length > 0
                  ? lane.columns.map((column) => <Fragment key={column}>{cards(columns[column])}</Fragment>)
                  : !isPending && <Empty>{lane.empty}</Empty>}
              </Column>
            ))}

            <DoneColumn
              open={doneOpen}
              view={showArchived ? 'archived' : 'done'}
              doneCount={columns.done.length}
              archivedCount={columns.archived.length}
              onOpen={() => setDoneOpen(true)}
              onCollapse={collapseDone}
              onView={(v) => setShowArchived(v === 'archived')}
            >
              {finishedList.length > 0 ? cards(finishedList) : <Empty>{showArchived ? 'Nothing archived.' : 'Nothing finished yet.'}</Empty>}
            </DoneColumn>
          </div>
        </DndContext>
      </div>

      <TodoDraftDialog target={draft} onClose={closeDraft} />
      {renaming && <TodoRenameDialog key={renaming.id} todo={renaming} onClose={() => setRenaming(null)} />}
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  )
}
