import { cn } from '@shared/lib/utils'
import { ChevronDown, Circle, CircleCheckBig, Ellipsis, Monitor, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'

import { useElapsedTimer } from '@renderer/hooks/use-elapsed-timer'
import { RequestError } from './request-error'
import { ACTIVITY_TREE_CONNECTORS, ACTIVITY_TREE_TRACER } from '@renderer/components/ui/tree-connectors'
import type { Todo } from '@shared/lib/utils/derive-task-list'
import { ActivityOrb, type ActivityOrbState } from './activity-orb'

/**
 * The activity card itself — the drawer that sits above the composer while a
 * turn is running. Purely presentational: every input arrives as a prop, and
 * the only state it owns is its own disclosure (collapsed, show-all-todos).
 *
 * AgentActivityIndicator is the live wrapper that derives these props from the
 * message stream.
 */

export interface ActivitySubagentItem {
  id: string
  name: string
  description: string
  status: 'running' | 'completed'
  progressSummary: string | null
}

export interface ActivityBackgroundTask {
  taskId: string
  startedAt: number
  isWorkflow?: boolean
  /** Background subagents already render as named subagent rows — excluded here. */
  isSubagent?: boolean
}

export interface ActivityComputerUse {
  app: string
  /** base64 PNG of the app icon; falls back to a generic monitor glyph. */
  iconBase64?: string | null
  revoking?: boolean
  revokeError?: boolean
  onRevoke: () => void
}

export interface ActivityCardProps {
  statusText: string
  orbState: ActivityOrbState
  /** Preformatted elapsed time; omitted before the turn has a start anchor. */
  elapsed?: string | null
  /** Parked on a blocking request: the card detaches from the composer. */
  isAwaitingInput?: boolean
  computerUse?: ActivityComputerUse | null
  subagents?: ActivitySubagentItem[]
  backgroundTasks?: ActivityBackgroundTask[]
  todos?: Todo[] | null
}

export function ActivityCard({
  statusText,
  orbState,
  elapsed,
  isAwaitingInput = false,
  computerUse,
  subagents = [],
  backgroundTasks = [],
  todos,
}: ActivityCardProps) {
  const [showAllTodos, setShowAllTodos] = useState(false)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)

  // Background subagents are excluded: they already render as named subagent
  // rows above, and counting them here would show the same work twice.
  const visibleBackgroundTasks = backgroundTasks.filter((task) => !task.isSubagent)
  const backgroundWorkflowCount = visibleBackgroundTasks.filter((task) => task.isWorkflow).length
  const backgroundProcessCount = visibleBackgroundTasks.length - backgroundWorkflowCount
  const activeSubagentCount = subagents.filter((item) => item.status === 'running').length
  const pendingTaskCount = todos?.filter((todo) => todo.status !== 'completed').length ?? 0
  // The tree is live work only — things running right now, hanging off the orb.
  // The plan is a different kind of thing (intent, not activity), so it sits
  // below the tree under its own header rather than taking branches.
  const hasTreeRows = !!computerUse
    || subagents.length > 0
    || visibleBackgroundTasks.length > 0
  const hasPlan = !!todos && pendingTaskCount > 0
  const hasExpandableDetails = hasTreeRows || hasPlan
  const collapsedSummary = [
    // Held first, and named: collapsing the tree must not be how a user loses
    // track that the agent still has hold of one of their apps.
    computerUse ? `computer use: ${computerUse.app}` : '',
    formatActivityCount(backgroundProcessCount, 'background process', 'background processes'),
    formatActivityCount(backgroundWorkflowCount, 'background workflow', 'background workflows'),
    formatActivityCount(activeSubagentCount, 'subagent', 'subagents'),
    formatActivityCount(pendingTaskCount, 'pending task', 'pending tasks'),
  ].filter(Boolean).join(', ')

  // Row positions on the tree: the tracer stages each branch flash off its own
  // index (see .tree-tracer in globals.css). Computer use leads the tree: it is
  // a hold that lasts the whole turn, so it keeps a fixed position while
  // subagents come and go beneath it.
  const computerUseRows = computerUse ? 1 : 0

  useTracerPhaseLock(listRef)

  return (
    <div className={cn(
      'mx-auto w-full max-w-[740px] px-4',
      isAwaitingInput ? 'mb-2' : '-mb-5',
    )}>
      {/* Capped and scrolled in place: a long action list must not grow the
          card until it pushes the chat history off screen. */}
      <div
        className={cn(
          'relative max-h-[30vh] overflow-y-auto border border-border/70 bg-background/85 px-3 pt-3 shadow-[0_0_24px_rgba(15,23,42,0.07),0_2px_10px_-4px_rgba(15,23,42,0.08)] backdrop-blur-md supports-[backdrop-filter]:bg-background/65 dark:shadow-[0_0_26px_rgba(0,0,0,0.22),0_2px_12px_-4px_rgba(0,0,0,0.16)]',
          isAwaitingInput
            ? 'rounded-2xl pb-3'
            : 'rounded-t-2xl border-b-0 pb-8',
        )}
        data-testid="activity-indicator"
      >
        {/* Header with the thought orb — its animation is the status cue. The
            disclosure button is the row's last child rather than positioned over
            it: items-center then centers it against the orb, and the gap keeps it
            off the summary, instead of a hand-tuned inset and a matching pr-* on
            the row that have to agree with the button's own size to stay right. */}
        <div
          className="flex min-w-0 items-center gap-2"
          data-testid="activity-indicator-header"
        >
          <ActivityOrb state={orbState} size={24} />
          <span className="min-w-0 truncate text-sm font-medium">{statusText}</span>
          {elapsed && (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{elapsed}</span>
          )}
          {isCollapsed && collapsedSummary && (
            <ActivitySummaryTicker text={collapsedSummary} />
          )}
          {hasExpandableDetails && (
            <button
              type="button"
              onClick={() => setIsCollapsed((collapsed) => !collapsed)}
              // ml-auto for the rows with nothing between the status and here —
              // the ticker's flex-1 already pushes it right whenever it is shown.
              className="-mr-1 ml-auto shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={!isCollapsed}
              aria-label={isCollapsed ? 'Expand activity details' : 'Collapse activity details'}
            >
              <ChevronDown
                className={cn('h-4 w-4 transition-transform', !isCollapsed && 'rotate-180')}
                aria-hidden="true"
              />
            </button>
          )}
        </div>

        {/* Streamed reasoning renders as a thinking card in the transcript
            (see ThinkingBlockItem) — only the "Thinking..." status shows here. */}

        {/* Live work, on ONE tree hanging off the header orb — computer use,
            subagents, then background work. A single <ul> rather than stacked
            sections so the rail runs unbroken and only the genuinely last row
            gets the closing elbow. Every row keeps the same 16px line box
            (text-xs) so the elbows, pinned at half that, stay centered. */}
        {!isCollapsed && hasTreeRows && (
          <ul ref={listRef} data-testid="activity-tree" className={cn(
            'mt-2 space-y-1 text-xs pl-6',
            ACTIVITY_TREE_CONNECTORS,
            ACTIVITY_TREE_TRACER,
          )}>
            {computerUse && (
              <ComputerUseRow
                computerUse={computerUse}
                tracerRow={0}
              />
            )}

            {subagents.map((item, index) => (
              <li
                key={item.id}
                style={tracerRowStyle(computerUseRows + index)}
                data-tracer-live={item.status === 'running' ? 'true' : undefined}
              >
                <div className="flex flex-col gap-0.5">
                  {/* A finished row recedes as a whole — the mark inherits the
                      muting with its label rather than carrying its own color. */}
                  <div className={cn(
                    'flex items-center gap-1.5',
                    item.status === 'completed' && 'text-muted-foreground',
                  )}>
                    <RowMark>
                      {item.status === 'completed' ? <span>✓</span> : null}
                    </RowMark>
                    <span className="font-mono">
                      {item.name}
                    </span>
                    {item.description && (
                      <span className="truncate text-muted-foreground">
                        {item.description}
                      </span>
                    )}
                  </div>
                  {item.progressSummary && item.status === 'running' && (
                    <span className="ml-5 italic text-muted-foreground">
                      {item.progressSummary}
                    </span>
                  )}
                </div>
              </li>
            ))}

            {visibleBackgroundTasks.length > 0 && (
              <BackgroundTasksRow
                tasks={visibleBackgroundTasks}
                tracerRow={computerUseRows + subagents.length}
              />
            )}
          </ul>
        )}

        {!isCollapsed && hasPlan && todos && (
          <TodoPlan
            todos={todos}
            showAllTodos={showAllTodos}
            setShowAllTodos={setShowAllTodos}
          />
        )}
      </div>
    </div>
  )
}

/**
 * The turn failed. Uses the app's one error treatment (RequestError — the same
 * banner the setup wizard and the settings forms use) rather than a card of its
 * own, so a failure here reads like a failure anywhere else.
 */
export function ActivityErrorCard({ message }: { message: string }) {
  return (
    <RequestError
      message={message}
      hint="Send another message to retry."
      // Opaque in dark too: this sits in the overlay footer with the transcript
      // scrolling behind it, where the shared banner's translucent dark fill
      // would let the messages show through.
      className="mt-0 dark:bg-red-950"
      data-testid="error-card"
    />
  )
}

function formatActivityCount(count: number, singular: string, plural: string): string {
  if (count === 0) return ''
  return `${count} ${count === 1 ? singular : plural}`
}

type ActivitySummaryTickerStyle = CSSProperties & {
  '--activity-summary-ticker-distance': string
  '--activity-summary-ticker-duration': string
}

function ActivitySummaryTicker({ text }: { text: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null)
  const contentRef = useRef<HTMLSpanElement>(null)
  const [scrollDistance, setScrollDistance] = useState(0)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return

    const measure = () => {
      const nextDistance = Math.max(0, Math.ceil(content.scrollWidth - viewport.clientWidth))
      setScrollDistance((currentDistance) => currentDistance === nextDistance ? currentDistance : nextDistance)
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(content)
    return () => observer.disconnect()
  }, [text])

  // The middle 64% of each animation leg is motion; the remaining time pauses
  // at either end so the summary can be read before it pans and before it resets.
  const durationSeconds = Math.max(5, scrollDistance / 20)
  const style: ActivitySummaryTickerStyle = {
    '--activity-summary-ticker-distance': `${scrollDistance}px`,
    '--activity-summary-ticker-duration': `${Math.round(durationSeconds * 100) / 100}s`,
  }

  return (
    <span
      ref={viewportRef}
      // Right-aligned so the summary sits against the disclosure button rather
      // than trailing the elapsed time. Still flex-1 rather than shrink-to-fit:
      // the marquee measures its overflow against this box, so it has to keep
      // spanning the gap. Alignment only bites when the text fits — once it
      // overflows the content is max-content wide and the marquee takes over.
      className="activity-summary-ticker min-w-0 flex-1 overflow-hidden whitespace-nowrap text-right text-xs italic text-muted-foreground"
      data-overflowing={scrollDistance > 0}
      data-testid="activity-summary-ticker"
      style={style}
      title={text}
    >
      <span
        ref={contentRef}
        className="activity-summary-ticker-content block truncate"
        data-activity-summary-ticker-content
      >
        {text}
      </span>
    </span>
  )
}

/**
 * A tree row's leading mark, boxed to one width so the marks — and the labels
 * beside them — line up down the list. Sized to the pulsing dot's own 12px
 * footprint: that box is mostly the ping halo's reserved room, so the 6px of ink
 * sits optically inset from both the branch and the label.
 *
 * A row with no mark reserves nothing and sits straight up against its branch,
 * rather than holding an empty box open. That is the point under the tracer,
 * where running rows carry no mark of their own — the cost is that a mixed list
 * indents its marked and unmarked rows differently.
 */
function RowMark({ children }: { children?: ReactNode }) {
  if (!children) return null
  return <span className="flex h-4 w-3 shrink-0 items-center justify-center">{children}</span>
}

/**
 * Holds the tracer's three animations — the trunk's travel, each branch's flash,
 * each row's shimmer — to one phase.
 *
 * They share a duration and are staggered by row, so on paper they read as a
 * single band running down the tree. What breaks that is WHEN each one starts: a
 * CSS animation's clock begins the moment it is applied to the element, not when
 * the card mounts. A subagent that goes live mid-turn, a task that flips to
 * in_progress, a row that finishes and drops out — each starts (or restarts) its
 * own timeline while the trunk is already partway through its cycle, and lands
 * on the wrong beat. Nothing drifts within one animation; they simply never
 * agreed on an origin.
 *
 * Pinning every one to the earliest start time already running means latecomers
 * join the band in flight. It settles immediately for animations already in
 * phase, so re-running it on every commit costs nothing.
 */
function useTracerPhaseLock(listRef: RefObject<HTMLUListElement | null>) {
  useEffect(() => {
    const list = listRef.current
    if (!list || typeof list.getAnimations !== 'function') return

    const lock = () => {
      // An animation does not exist until the style declaring it is
      // recalculated, and that can land after this commit's effects have run.
      // Force the flush first — reading getAnimations() without it returns only
      // the animations from before this render, so a row that just went live is
      // missed and, with no further commit coming, never gets locked at all.
      getComputedStyle(list).animationName
      // Only the tracer's own animations. The subtree also carries hover
      // transitions (transition-colors on the row buttons), and pulling those
      // back to the tracer's origin — far in the past — completes them
      // instantly, snapping the fade.
      const animations = list
        .getAnimations({ subtree: true })
        .filter((animation) =>
          animation.startTime != null &&
          'animationName' in animation &&
          (animation as CSSAnimation).animationName.startsWith('tree-tracer'))
      if (animations.length < 2) return

      const origin = Math.min(...animations.map((animation) => Number(animation.startTime)))
      for (const animation of animations) {
        if (Number(animation.startTime) !== origin) animation.startTime = origin
      }
    }

    lock()
    // Second pass next frame, for animations the flush above still raced.
    const frame = requestAnimationFrame(lock)
    return () => cancelAnimationFrame(frame)
  })
}

/** Inline hook the tracer keyframes read to stage each branch's flash. */
function tracerRowStyle(index: number): CSSProperties {
  return { '--tree-tracer-row': index } as CSSProperties
}

/**
 * The app the turn currently has hold of, as a tree row.
 *
 * Deliberately kept at full strength rather than muted like a finished row: the
 * user granted this, it is still in force, and the row is the only place the UI
 * says so once the header badge is gone. The revoke control travels with it.
 */
function ComputerUseRow({ computerUse, tracerRow }: {
  computerUse: ActivityComputerUse
  tracerRow: number
}) {
  return (
    <li style={tracerRowStyle(tracerRow)} data-tracer-live="true">
      <div className="flex items-center gap-1.5">
        <RowMark>
          {computerUse.iconBase64 ? (
            <img
              src={`data:image/png;base64,${computerUse.iconBase64}`}
              alt=""
              className="h-3 w-3 rounded-[2px]"
            />
          ) : (
            <Monitor className="h-3 w-3" />
          )}
        </RowMark>
        <span className="truncate">Computer use: {computerUse.app}</span>
        {/* Said out loud, not just implied by a red glyph and a tooltip — the
            hold is still in force and the user needs to know the release did
            not take. */}
        {computerUse.revokeError && (
          <span className="shrink-0 text-destructive">Revoke failed</span>
        )}
        <button
          type="button"
          onClick={computerUse.onRevoke}
          disabled={computerUse.revoking}
          className={cn(
            'shrink-0 cursor-pointer rounded p-0.5 transition-colors',
            computerUse.revokeError
              ? 'text-destructive hover:bg-destructive/10'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
          title={computerUse.revokeError ? 'Failed to revoke — click to retry' : 'Release app and revoke permission'}
          aria-label={computerUse.revokeError
            ? `Retry releasing ${computerUse.app} and revoking permission`
            : `Release ${computerUse.app} and revoke permission`}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </li>
  )
}

/** One tree row standing in for all active background work. */
function BackgroundTasksRow({ tasks, tracerRow }: {
  tasks: ActivityBackgroundTask[]
  tracerRow: number
}) {
  const earliest = Math.min(...tasks.map(t => t.startedAt))
  const elapsed = useElapsedTimer(new Date(earliest))
  // Label as "workflow" when every active background task is a dynamic workflow;
  // fall back to the generic "process" wording for backgrounded Bash (or a mix).
  const allWorkflows = tasks.every(t => t.isWorkflow)
  const noun = allWorkflows ? 'workflow' : 'process'
  const label = `${tasks.length} background ${tasks.length === 1 ? noun : allWorkflows ? `${noun}s` : `${noun}es`}`
  return (
    <li style={tracerRowStyle(tracerRow)} data-tracer-live="true">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">{label}</span>
        {elapsed && (
          <span className="text-muted-foreground tabular-nums">{elapsed}</span>
        )}
      </div>
    </li>
  )
}

/**
 * The task list, under the tree rather than on it: the tree is live work, and
 * the plan is intent. A small "Plan" header owns the section, with the
 * truncation toggle beside it instead of spending a row on it. Items run
 * pending/in-progress first, then finished ones newest first.
 */
function TodoPlan({
  todos,
  showAllTodos,
  setShowAllTodos,
}: {
  todos: Todo[]
  showAllTodos: boolean
  setShowAllTodos: (show: boolean) => void
}) {
  const MAX_VISIBLE = 5
  const needsTruncation = todos.length > MAX_VISIBLE && !showAllTodos

  const notDone = todos.filter(t => t.status !== 'completed')
  const doneReversed = todos.filter(t => t.status === 'completed').reverse()

  let visibleTodos: Todo[]
  let hiddenTodos: Todo[]

  if (!needsTruncation) {
    visibleTodos = [...notDone, ...doneReversed]
    hiddenTodos = []
  } else {
    const visibleNotDone = notDone.slice(0, MAX_VISIBLE)
    const remainingSlots = MAX_VISIBLE - visibleNotDone.length
    const visibleDone = doneReversed.slice(0, remainingSlots)
    visibleTodos = [...visibleNotDone, ...visibleDone]
    const visibleSet = new Set(visibleTodos)
    hiddenTodos = todos.filter(t => !visibleSet.has(t))
  }

  const hiddenPending = hiddenTodos.filter(t => t.status !== 'completed').length
  const hiddenDone = hiddenTodos.filter(t => t.status === 'completed').length

  return (
    <div className="mt-2 pl-6 text-xs" data-testid="activity-plan">
      {/* Indented to the tree rows' own left edge so the two sections read as
          one column, plan marks under tree marks. */}
      <div className="flex items-center gap-2">
        <span className="font-medium text-muted-foreground">Plan</span>
        {hiddenTodos.length > 0 && (
          <button
            onClick={() => setShowAllTodos(true)}
            className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            {hiddenTodos.length} more{': '}
            {[
              hiddenPending > 0 && `${hiddenPending} pending`,
              hiddenDone > 0 && `${hiddenDone} done`,
            ].filter(Boolean).join(', ')}
          </button>
        )}
        {showAllTodos && todos.length > MAX_VISIBLE && (
          <button
            onClick={() => setShowAllTodos(false)}
            className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            Show fewer
          </button>
        )}
      </div>
      <ul className="mt-1 space-y-1">
        {visibleTodos.map((todo, index) => (
          <li key={index}>
            <div
              className={cn(
                'flex items-center gap-1.5',
                // Only the task being worked on carries full weight. Pending
                // used to sit at plain foreground, which made the row NOT being
                // worked on the darkest thing in the list.
                todo.status === 'in_progress'
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground'
              )}
            >
              <RowMark>
                {todo.status === 'completed' ? (
                  // No strikethrough — the ringed check plus the muted label is
                  // enough, and it keeps the row readable. Uncolored on purpose:
                  // it inherits the completed row's muted-foreground, so the
                  // mark recedes with its label instead of being the loudest
                  // thing in a finished row.
                  <CircleCheckBig className="h-3 w-3" aria-hidden data-testid="todo-status-completed" />
                ) : todo.status === 'in_progress' ? (
                  <Ellipsis className="h-3 w-3" aria-hidden data-testid="todo-status-in-progress" />
                ) : (
                  // Same 12px box and stroke as the check, so a task's mark
                  // doesn't change size when it completes.
                  <Circle className="h-3 w-3" aria-hidden data-testid="todo-status-pending" />
                )}
              </RowMark>
              <span className="truncate">{todo.content}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
