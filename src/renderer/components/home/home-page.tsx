
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearch as useRouteSearch } from '@tanstack/react-router'
import { WidgetBoard, WidgetSizePopover, type GridRect, type WidgetItem, type WidgetSizeKey } from './widget-grid'
import { useAgents, useStartAgent, useStopAgent } from '@renderer/hooks/use-agents'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { useMarkSessionNotificationsRead } from '@renderer/hooks/use-notifications'
import { useHomeCardHealth } from '@renderer/hooks/use-home-card-health'
import { applyAgentOrder } from '@renderer/lib/agent-ordering'
import { useNotableSessions } from '@renderer/hooks/use-sessions'
import { Halftone } from '@renderer/components/agents/halftone'
import {
  ActivitySparkChart,
  CronSparkChart,
  summarizeDailyActivity,
} from '@renderer/components/activity/activity-spark-chart'
import { DEFAULT_ACTIVITY_DAYS } from '@shared/lib/types/activity'
import {
  type HomeCardCron,
  type HomeCardHealthData,
  type HomeCardWebhook,
} from '@shared/lib/types/home-card-health-schema'
import { getAgentActivityStatus } from '@shared/lib/types/agent-activity-status'
import { WorkingDots, AwaitingDot, UnreadDot } from '@renderer/components/agents/status-indicators'
import { AgentContextMenu } from '@renderer/components/agents/agent-context-menu'
import { useCreateUntitledAgent } from '@renderer/hooks/use-create-untitled-agent'
import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import { Button } from '@renderer/components/ui/button'
import { AppLink } from '@renderer/components/ui/app-link'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { ContextMenuSwitchItem } from '@renderer/components/ui/context-menu'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { useIsMobile } from '@renderer/hooks/use-mobile'
import { DashboardCard } from './dashboard-card'
import { PwaInstallBanner } from './pwa-install-banner'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { Plus, Bot, Loader2, Search, Power, Square, Check, ArrowRight, LayoutGrid, Waypoints, MoreVertical, Move } from 'lucide-react'
import { useSearch } from '@renderer/context/search-context'
import { cn } from '@shared/lib/utils/cn'
import type { ApiAgent } from '@shared/lib/types/api'
import { formatDistanceToNow } from 'date-fns'
import { useRenderTracker } from '@renderer/lib/perf'
import { toast } from 'sonner'

// Code-split: the graph pulls in @xyflow/react + d3-force, which nobody
// should pay for on a cards-only page load.
const AgentGraph = lazy(() =>
  import('./graph/agent-graph').then((m) => ({ default: m.AgentGraph })),
)

// Per-status ink color for the card's halftone banner. Motion/form (the motif)
// distinguishes agents; color just reflects activity state.
const HALFTONE_INK: Record<ReturnType<typeof getAgentActivityStatus>, string> = {
  sleeping: 'text-muted-foreground/50',
  idle: 'text-muted-foreground',
  working: 'text-foreground',
  awaiting_input: 'text-orange-500',
}

function hashSlug(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!media) return
    const update = () => setReduced(media.matches)
    update()
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])

  return reduced
}

// State label for the top-right status/control chip.
const AGENT_STATE_TAG: Record<'sleeping' | 'idle' | 'working' | 'awaiting', string> = {
  sleeping: 'Sleeping',
  idle: 'Idle',
  working: 'Working…',
  awaiting: 'Needs input',
}

function AgentCardPowerButton({ agent }: { agent: ApiAgent }) {
  const startAgent = useStartAgent()
  const stopAgent = useStopAgent()
  const isRunning = agent.status === 'running'
  const isPending = isRunning ? stopAgent.isPending : startAgent.isPending
  const tagState: 'sleeping' | 'idle' | 'working' | 'awaiting' = !isRunning
    ? 'sleeping'
    : agent.hasSessionsAwaitingInput
      ? 'awaiting'
      : agent.hasActiveSessions
        ? 'working'
        : 'idle'
  const label = AGENT_STATE_TAG[tagState]

  const activate = (e: React.SyntheticEvent) => {
    e.stopPropagation()
    if (isPending) return
    if (isRunning) {
      stopAgent.mutate(agent.slug)
    } else {
      startAgent.mutate(agent.slug)
    }
  }

  return (
    // Frosted status chip with a white-bordered stop/power button inside. It's a
    // flex item in the card's control row (see AgentCard), so the kebab aligns
    // with it natively.
    <div className="flex items-center gap-1.5 rounded-md border border-border/50 bg-white/10 py-0.5 pl-1.5 pr-1 text-xs backdrop-blur-sm">
      <span className="leading-none text-muted-foreground">{label}</span>
      <button
        type="button"
        disabled={isPending}
        aria-label={isRunning ? 'Stop agent' : 'Wake up agent'}
        title={isRunning ? 'Stop agent' : 'Wake up agent'}
        onClick={activate}
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded border bg-background text-foreground shadow-sm',
          'cursor-pointer transition-colors hover:bg-muted',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          'disabled:cursor-wait disabled:opacity-60'
        )}
      >
        {isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : isRunning ? (
          <Square className="h-2.5 w-2.5 fill-current" />
        ) : (
          <Power className="h-2.5 w-2.5" />
        )}
      </button>
    </div>
  )
}

// Baked halftone render settings + per-state motion (chosen during exploration;
// the dev tweak panel that produced them lives on the animation-experiments-draft
// branch). flow_3d is the working/idle/sleeping identity; pulse (in orange ink,
// via HALFTONE_INK) is the needs-input state.
const HALFTONE_STATE: Record<'sleeping' | 'idle' | 'working', { speed: number; dim: number; contrast: number }> = {
  // Clear separation: sleeping/idle are slow + faint + soft; working is notably
  // faster, fuller, and higher-contrast (bolder, denser dots).
  sleeping: { speed: 0.25, dim: 0.4, contrast: 1.35 },
  idle: { speed: 0.4, dim: 0.5, contrast: 1.4 },
  working: { speed: 0.9, dim: 1, contrast: 1.95 },
}

function AgentCardMatrix({
  slug,
  status,
  hasActiveSessions,
  hasSessionsAwaitingInput,
  className,
}: {
  slug: string
  status: 'running' | 'stopped'
  hasActiveSessions: boolean
  hasSessionsAwaitingInput: boolean
  /** Banner geometry (aspect ratio or fixed height); defaults to the wide strip. */
  className?: string
}) {
  const activityStatus = getAgentActivityStatus(status, hasActiveSessions, hasSessionsAwaitingInput)
  const stateTweak = activityStatus === 'awaiting_input' ? undefined : HALFTONE_STATE[activityStatus]
  return (
    <div
      aria-hidden="true"
      className={cn('w-full overflow-hidden', className ?? 'aspect-[32/9]', HALFTONE_INK[activityStatus])}
    >
      <Halftone
        motif={activityStatus === 'awaiting_input' ? 'pulse' : 'flow_3d'}
        state={activityStatus === 'working' ? 'working' : activityStatus === 'awaiting_input' ? 'alert' : 'idle'}
        speed={stateTweak?.speed}
        dim={stateTweak?.dim}
        spacing={5}
        maxRadius={1.3}
        vignette={0.4}
        contrast={stateTweak?.contrast ?? 1.6}
        speedScale={1}
        seed={hashSlug(slug)}
      />
    </div>
  )
}

interface NotableSession {
  id: string
  name: string
  isActive?: boolean
  isAwaitingInput?: boolean
  hasUnreadNotifications?: boolean
  lastActivityAt?: Date | string
}

/**
 * Strip a leading agent-name prefix from a session name — inside the agent's
 * own card it's redundant ("Test Agent One Story Session" → "Story Session").
 * Matches the longest run of the agent's leading words (so partial prefixes
 * like "Test Agent Linear…" under "Test Agent One" still strip), but requires
 * at least two words (or the full single-word name) to avoid false positives.
 */
function stripAgentPrefix(sessionName: string, agentName: string): string {
  const sessionWords = sessionName.trim().split(/\s+/)
  const agentWords = agentName.trim().split(/\s+/).filter(Boolean)
  if (agentWords.length === 0) return sessionName
  let matched = 0
  while (
    matched < agentWords.length &&
    matched < sessionWords.length &&
    sessionWords[matched].toLowerCase() === agentWords[matched].toLowerCase()
  ) {
    matched++
  }
  if (matched < Math.min(2, agentWords.length)) return sessionName
  const rest = sessionWords.slice(matched).join(' ').replace(/^[\s:–—\-·]+/, '')
  return rest.length >= 3 ? rest : sessionName
}

/** Compact relative age: 4m, 1h, 2d. */
function compactAgo(date: Date | string | undefined): string | null {
  if (!date) return null
  const mins = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60_000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

type SessionState = 'awaiting' | 'working' | 'unread'

// Notification-row prefix describing what happened in the session.
const SESSION_STATE_PREFIX: Record<SessionState, string> = {
  awaiting: 'Input needed',
  working: 'Working',
  unread: 'New message',
}

function sessionState(s: NotableSession): SessionState {
  if (s.isAwaitingInput) return 'awaiting'
  if (s.isActive) return 'working'
  return 'unread'
}

function SessionStateDot({ state }: { state: SessionState }) {
  // The three dots have different intrinsic footprints (awaiting reserves 12px
  // for its ping halo, unread is a bare 6px). Center each in one fixed 12px box
  // so the dot centers — and the text start — align across rows.
  const dot =
    state === 'awaiting' ? <AwaitingDot /> : state === 'working' ? <WorkingDots dotClassName="bg-foreground" /> : <UnreadDot />
  return <span className="flex h-3 w-3 shrink-0 items-center justify-center">{dot}</span>
}

/**
 * Notifications section: a frosted panel (matching the title pill / health
 * chips) of hairline-divided rows — state dot, name, and a right-aligned
 * compact timestamp. Sizes to its content and scrolls when the list outgrows
 * the space available in the card.
 */
function AgentCardSessions({
  agentSlug,
  agentDisplaySlug,
  agentName,
  sessions,
}: {
  agentSlug: string
  agentDisplaySlug: string
  agentName: string
  sessions: NotableSession[] | undefined
}) {
  const navigate = useNavigate()
  const markRead = useMarkSessionNotificationsRead()
  const notable = useMemo(
    () => (sessions ?? []).filter((s) => s.isActive || s.isAwaitingInput || s.hasUnreadNotifications),
    [sessions]
  )
  if (notable.length === 0) return null
  const open = (id: string) => {
    void navigate({ to: '/agents/$slug/sessions/$sessionId', params: { slug: agentSlug, sessionId: id } })
  }
  // Show up to three rows as-is; with four or more, show two and collapse the
  // rest into a trailing "{X} more →" row.
  const visible = notable.length > 3 ? notable.slice(0, 2) : notable
  const moreCount = notable.length - visible.length

  return (
    <div className="pointer-events-auto flex max-h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/50 bg-white/10 backdrop-blur-sm">
      <div className="min-h-0 overflow-y-auto px-2 py-1">
        {visible.map((s) => {
          const st = sessionState(s)
          const right = compactAgo(s.lastActivityAt) ?? ''
          return (
            <div
              key={s.id}
              className="group/row flex h-6 w-full items-center gap-2.5 text-xs"
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  open(s.id)
                }}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <SessionStateDot state={st} />
                <span className="truncate text-foreground">
                  <span className="text-muted-foreground">{SESSION_STATE_PREFIX[st]}: </span>
                  {stripAgentPrefix(s.name, agentName)}
                </span>
              </button>
              {st === 'unread' || st === 'awaiting' ? (
                <>
                  <span className="shrink-0 text-muted-foreground tabular-nums">{right}</span>
                  <span className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
                    {st === 'unread' && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          markRead.mutate(s.id)
                        }}
                        aria-label="Mark as read"
                        title="Mark as read"
                        className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        open(s.id)
                      }}
                      aria-label="Open session"
                      title="Open session"
                      className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </>
              ) : (
                <span className="shrink-0 text-muted-foreground tabular-nums">{right}</span>
              )}
            </div>
          )
        })}
        {moreCount > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void navigate({ to: '/agents/$slug', params: { slug: agentDisplaySlug } })
            }}
            className="group/row flex h-6 w-full cursor-pointer items-center justify-end gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <span>{moreCount} more</span>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-60 transition-all group-hover/row:opacity-100">
              <ArrowRight className="h-3.5 w-3.5" />
            </span>
          </button>
        )}
      </div>
    </div>
  )
}

type HealthSlide = { kind: 'cron' | 'webhook'; id: string; name: string }

/**
 * Rotating health carousel for the card's bottom row. One full-width slide at
 * a time — each cron's run history (CronSparkChart) and each webhook's daily
 * volume (ActivitySparkChart), fed by the real /api/activity rollups — so
 * labels get the whole row instead of clipping. Auto-advances every few
 * seconds, pauses on hover; the dots jump straight to a slide; a slide click
 * opens that trigger's page.
 */
function AgentHealthCarousel({
  agent,
  crons,
  webhooks,
  health,
}: {
  agent: ApiAgent
  crons: HomeCardCron[]
  webhooks: HomeCardWebhook[]
  health?: HomeCardHealthData
}) {
  const navigate = useNavigate()
  const slides = useMemo<HealthSlide[]>(
    () => [
      ...crons.map((c) => ({ kind: 'cron' as const, id: c.id, name: c.name ?? c.scheduleExpression })),
      ...webhooks.map((w) => ({ kind: 'webhook' as const, id: w.id, name: w.name ?? w.triggerType })),
    ],
    [crons, webhooks]
  )
  const count = slides.length
  const [index, setIndex] = useState(0)
  const [hovered, setHovered] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const reduceMotion = usePrefersReducedMotion()
  const paused = hovered || focusWithin || reduceMotion

  useEffect(() => {
    if (paused || count < 2) return
    const t = setInterval(() => setIndex((i) => (i + 1) % count), 4000)
    return () => clearInterval(t)
  }, [paused, count])

  if (count === 0) return null
  const active = slides[index % count]

  const openSlide = (s: HealthSlide) => {
    if (s.kind === 'cron') {
      void navigate({ to: '/agents/$slug/tasks/$taskId', params: { slug: agent.slug, taskId: s.id } })
    } else {
      void navigate({ to: '/agents/$slug/webhooks/$webhookId', params: { slug: agent.slug, webhookId: s.id } })
    }
  }

  const renderSlide = (s: HealthSlide) => {
    let chart: ReactNode
    let metric = ''
    if (s.kind === 'cron') {
      const activity = health?.cronByTaskId[s.id] ?? []
      const succeeded = activity.filter((p) => p.status === 'succeeded').length
      chart = <CronSparkChart label={s.name} data={activity} className="h-5 w-24" />
      metric = `${succeeded}/${activity.length}`
    } else {
      const activity = health?.webhookByTriggerId[s.id] ?? []
      const { total } = summarizeDailyActivity(activity)
      chart = <ActivitySparkChart label={s.name} data={activity} className="h-5 w-24" />
      metric = `${total}/${health?.days ?? DEFAULT_ACTIVITY_DAYS}d`
    }
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          openSlide(s)
        }}
        className="flex w-full cursor-pointer items-center gap-2 text-xs"
      >
        <span className="min-w-0 flex-1 truncate">
          <span className="text-foreground">{s.name}</span>{' '}
          <span className="text-muted-foreground">{s.kind === 'cron' ? 'Cron' : 'Webhook'}</span>
        </span>
        <span className="shrink-0">{chart}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{metric}</span>
      </button>
    )
  }

  return (
    <div
      className="pointer-events-auto mt-auto flex shrink-0 items-center gap-1.5"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false)
      }}
    >
      {/* The frosted panel (title's bg-white/10 + backdrop-blur) lives on the
          container so the halftone reads softly through it and never flashes.
          A single content layer slides up inside it on each change — nothing
          underneath to bleed through. */}
      <div className="relative min-w-0 flex-1 overflow-hidden rounded-md border border-border/50 bg-white/10 backdrop-blur-sm">
        <div
          key={active.id}
          className={cn('px-2 py-1.5', !reduceMotion && 'animate-in slide-in-from-bottom-full duration-300')}
        >
          {renderSlide(active)}
        </div>
      </div>
      {/* Vertical position dots, outside the chip to the right */}
      {count > 1 && (
        <span className="flex shrink-0 items-center">
          {slides.map((s, i) => (
            <button
              type="button"
              key={s.id}
              onClick={(e) => {
                e.stopPropagation()
                setIndex(i)
              }}
              aria-label={`Show health row ${i + 1} of ${count}`}
              aria-pressed={i === index % count}
              className="group inline-flex h-6 w-6 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                className={cn(
                  'h-[3px] w-[3px] rounded-full transition-colors',
                  i === index % count ? 'bg-foreground/70' : 'bg-muted-foreground/30 group-hover:bg-muted-foreground/60'
                )}
              />
            </button>
          ))}
        </span>
      )}
    </div>
  )
}

/**
 * Small-card title meta as a ticker: a single line that continuously scrolls
 * "Last run X · {N} new notifications" (orange needs-input dot wins over blue
 * unread), looping seamlessly via a duplicated run.
 */
function TickerTitleMeta({
  lastWorked,
  notifCount,
  notifState,
}: {
  lastWorked: string | null
  notifCount: number
  notifState: SessionState
}) {
  const run = (
    <span className="flex items-center gap-1.5 pr-8 text-muted-foreground">
      <span>Last run {lastWorked ?? 'never'}</span>
      <SessionStateDot state={notifState} />
      <span>
        {notifCount} new notification{notifCount !== 1 ? 's' : ''}
      </span>
    </span>
  )
  return (
    <div className="relative h-4 overflow-hidden text-xs">
      <div className="home-title-ticker flex w-max items-center whitespace-nowrap group-hover/widget:[animation-play-state:paused] group-focus-within/widget:[animation-play-state:paused]">
        {run}
        {run}
      </div>
    </div>
  )
}

/**
 * Agent card, size-aware for the widget grid:
 *   S (1×1) — full-bleed halftone glance tile: title + last run + state pill.
 *   W (2×1) — banner strip, notifications in the middle, cron + webhook charts
 *             sharing one row pinned to the bottom.
 */
function AgentCard({
  agent,
  size = 'W',
  additionalOptions,
  onArrange,
  disableTouchLongPress,
  crons = [],
  webhooks = [],
  health,
}: {
  agent: ApiAgent
  size?: WidgetSizeKey
  additionalOptions?: ReactNode
  onArrange?: () => void
  disableTouchLongPress?: boolean
  crons?: HomeCardCron[]
  webhooks?: HomeCardWebhook[]
  health?: HomeCardHealthData
}) {
  useRenderTracker('AgentCard')
  const lastWorked = agent.lastActivityAt ? formatDistanceToNow(new Date(agent.lastActivityAt), { addSuffix: true }) : null

  const isSmall = size === 'S'

  // Fetch sessions whenever there are notable ones — the Wide card lists them,
  // the Small card rotates a count into the title.
  const hasNotable = agent.hasActiveSessions || agent.hasSessionsAwaitingInput || agent.hasUnreadNotifications
  const { data: sessions } = useNotableSessions(hasNotable ? agent.slug : null, {
    limit: 100,
    staleTime: 30_000,
  })

  // Notification summary for the Small card's rotating title meta. Orange
  // (needs input) always wins over blue (unread).
  const notifSessions = useMemo(
    () => (sessions ?? []).filter((s) => s.isAwaitingInput || s.hasUnreadNotifications),
    [sessions]
  )
  const notifState: SessionState | null = notifSessions.some((s) => s.isAwaitingInput)
    ? 'awaiting'
    : notifSessions.length > 0
      ? 'unread'
      : null

  const titleOverlay = (
    <div className="pointer-events-none absolute bottom-2 left-4 z-10 max-w-[calc(100%-2rem)] rounded-md bg-white/10 px-2.5 py-1 backdrop-blur-sm">
      <div className="truncate text-sm font-normal text-foreground">{agent.name}</div>
      {isSmall && notifState ? (
        <TickerTitleMeta lastWorked={lastWorked} notifCount={notifSessions.length} notifState={notifState} />
      ) : (
        <div className="truncate text-xs text-muted-foreground">Last run {lastWorked ?? 'never'}</div>
      )}
    </div>
  )

  return (
    <AgentContextMenu
      agent={agent}
      additionalOptions={additionalOptions}
      onArrange={onArrange}
      disableTouchLongPress={disableTouchLongPress}
    >
      <div
        className="relative flex h-full w-full flex-col gap-3 overflow-hidden rounded-lg border bg-card p-4 text-left shadow-sm transition-[box-shadow,transform,border-color] duration-150 hover:border-accent-foreground/20 group-hover/widget:-translate-y-0.5 group-hover/widget:shadow-md"
      >
        {/* Keep navigation as a sibling of the card controls so the DOM never
            nests buttons inside a button. Interactive rows sit above this
            transparent hit target and handle their own actions. */}
        <AppLink
          to="/agents/$slug"
          params={{ slug: agent.displaySlug }}
          draggable={false}
          data-widget-drag-surface=""
          aria-label={`Open ${agent.name}`}
          onKeyDown={(event) => {
            if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            event.currentTarget.dispatchEvent(
              new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                clientX: rect.right,
                clientY: rect.top,
              })
            )
          }}
          className="absolute inset-0 z-20 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />

        {/* The card has one visible control row and one menu surface: its
            right-click/long-press context menu. The focused card link also
            opens that menu with the standard Shift+F10 keyboard gesture. */}
        <div className="absolute top-2 right-4 z-30">
          <AgentCardPowerButton agent={agent} />
        </div>

        {isSmall ? (
          /* Glance tile: the halftone fills the card, content overlays it. */
          <>
            <div className="absolute inset-0">
              <AgentCardMatrix
                slug={agent.slug}
                status={agent.status}
                hasActiveSessions={agent.hasActiveSessions ?? false}
                hasSessionsAwaitingInput={agent.hasSessionsAwaitingInput ?? false}
                className="h-full"
              />
            </div>
            {titleOverlay}
          </>
        ) : (
          /* Wide: same glance-tile footing as Small — halftone fills the card,
             title in the bottom-left corner — with the notifications + health
             carousel overlaid on top. The content reserves bottom space (pb-11)
             so it clears the title pill. */
          <>
            <div className="absolute inset-0">
              <AgentCardMatrix
                slug={agent.slug}
                status={agent.status}
                hasActiveSessions={agent.hasActiveSessions ?? false}
                hasSessionsAwaitingInput={agent.hasSessionsAwaitingInput ?? false}
                className="h-full"
              />
            </div>
            <div className="pointer-events-none relative z-30 flex min-h-0 flex-1 flex-col gap-1.5 pb-11">
              {/* Notifications sit directly above the cron/webhook carousel
                  (bottom-aligned); any slack opens up above them. Scrolls when
                  the list overflows. */}
              <div className="flex min-h-0 flex-1 flex-col justify-end">
                <AgentCardSessions
                  agentSlug={agent.slug}
                  agentDisplaySlug={agent.displaySlug}
                  agentName={agent.name}
                  sessions={sessions}
                />
              </div>
              {/* Rotating cron/webhook health carousel (renders nothing when
                  the agent has no triggers). */}
              <AgentHealthCarousel agent={agent} crons={crons} webhooks={webhooks} health={health} />
            </div>
            {titleOverlay}
          </>
        )}
      </div>
    </AgentContextMenu>
  )
}

/** Widget-grid key for a dashboard tile. Agents use their bare slug. */
const dashKey = (agentSlug: string, dashSlug: string) => `dash::${agentSlug}::${dashSlug}`

function dashboardAgentSlugFromKey(id: string): string | null {
  if (!id.startsWith('dash::')) return null
  const rest = id.slice('dash::'.length)
  const separator = rest.indexOf('::')
  return separator === -1 ? null : rest.slice(0, separator)
}

function HomeArrangeMenu({
  onArrange,
  disabled,
}: {
  onArrange: () => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Agent layout options"
          title="Agent layout options"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-40 p-1">
        <button
          type="button"
          data-testid="home-arrange-action"
          disabled={disabled}
          onClick={() => {
            setOpen(false)
            onArrange()
          }}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
        >
          <Move className="h-4 w-4" />
          Arrange
        </button>
      </PopoverContent>
    </Popover>
  )
}

export function HomePage() {
  useRenderTracker('HomePage')
  const { data: agents, isLoading: agentsLoading } = useAgents()
  const { data: userSettings } = useUserSettings()
  const updateSettings = useUpdateUserSettings()
  const isMobile = useIsMobile()
  const layoutTarget = isMobile ? 'mobile' : 'desktop'
  // Cards vs. graph view — URL-driven (`/?view=graph`) so back/forward
  // navigation and reloads restore the selection; absent = cards.
  const navigate = useNavigate()
  const routeSearch = useRouteSearch({ strict: false }) as { view?: string }
  const view: 'cards' | 'graph' = routeSearch.view === 'graph' ? 'graph' : 'cards'

  // agentOrder (sidebar drag order) drives the initial flow-pack order of
  // uncustomized boards; once the user drags/resizes here, the layout for the
  // current breakpoint wins.
  const orderedAgents = useMemo(
    () => applyAgentOrder(agents ?? [], userSettings?.agentOrder),
    [agents, userSettings?.agentOrder]
  )

  // Desktop and phone layouts are intentionally independent. A phone without a
  // customized layout starts from the desktop map and is responsively re-packed
  // by WidgetBoard, but its first save forks into homeGridMobileLayout.
  const [localDesktopLayout, setLocalDesktopLayout] = useState<Record<string, GridRect> | null>(null)
  const [localMobileLayout, setLocalMobileLayout] = useState<Record<string, GridRect> | null>(null)
  const layoutMutationVersion = useRef({ desktop: 0, mobile: 0 })
  const savedDesktopLayout = localDesktopLayout ?? userSettings?.homeGridLayout
  const savedMobileLayout =
    localMobileLayout ?? userSettings?.homeGridMobileLayout ?? savedDesktopLayout
  const savedLayout = isMobile ? savedMobileLayout : savedDesktopLayout
  // Arrange mode stages its layout locally. Done persists the staged map once;
  // Cancel drops it and restores the last saved geometry.
  const [isArranging, setIsArranging] = useState(false)
  const [arrangeLayout, setArrangeLayout] = useState<Record<string, GridRect> | null>(null)
  const [arrangeTarget, setArrangeTarget] = useState<'desktop' | 'mobile' | null>(null)
  const displayedLayout = arrangeLayout ?? savedLayout

  // Agents whose associated app/dashboard card is toggled off. localHidden is a
  // session override that wins over the server value, so the toggle takes effect
  // immediately and isn't clobbered by the post-save refetch.
  const [localHidden, setLocalHidden] = useState<Set<string> | null>(null)
  const hiddenMutationVersion = useRef(0)
  const hiddenApps = useMemo(
    () => localHidden ?? new Set(userSettings?.hiddenAppCards ?? []),
    [localHidden, userSettings?.hiddenAppCards]
  )
  const [arrangeHiddenApps, setArrangeHiddenApps] = useState<Set<string> | null>(null)
  const displayedHiddenApps = arrangeHiddenApps ?? hiddenApps

  const { widgetItems, dashboardsById, agentsWithApp } = useMemo(() => {
    const items: WidgetItem[] = []
    const dashes = new Map<string, { agentSlug: string; dashboard: { slug: string; name: string } }>()
    const withApp = new Set<string>()
    for (const agent of orderedAgents) {
      items.push({ id: agent.slug, rect: displayedLayout?.[agent.slug], defaultSize: 'W' })
      const dashboards = Array.isArray(agent.dashboards) ? agent.dashboards : []
      if (dashboards.length > 0) withApp.add(agent.slug)
      if (displayedHiddenApps.has(agent.slug)) continue // app card toggled off — skip its dashboard tiles
      for (const d of dashboards) {
        const id = dashKey(agent.slug, d.slug)
        items.push({ id, rect: displayedLayout?.[id], defaultSize: 'S' })
        dashes.set(id, { agentSlug: agent.slug, dashboard: d })
      }
    }
    return { widgetItems: items, dashboardsById: dashes, agentsWithApp: withApp }
  }, [orderedAgents, displayedLayout, displayedHiddenApps])

  const agentBySlug = useMemo(() => new Map(orderedAgents.map((a) => [a.slug, a])), [orderedAgents])

  // Card view owns a compact automation+activity projection. The full graph
  // topology is fetched only by the lazily mounted AgentGraph.
  const { data: cardHealth } = useHomeCardHealth(view === 'cards' && orderedAgents.length > 0)
  const { cronsByAgent, webhooksByAgent } = useMemo(() => {
    const cronsMap = new Map<string, HomeCardCron[]>()
    const webhooksMap = new Map<string, HomeCardWebhook[]>()
    for (const cron of cardHealth?.crons ?? []) {
      const list = cronsMap.get(cron.agentSlug) ?? []
      list.push(cron)
      cronsMap.set(cron.agentSlug, list)
    }
    for (const webhook of cardHealth?.webhooks ?? []) {
      const list = webhooksMap.get(webhook.agentSlug) ?? []
      list.push(webhook)
      webhooksMap.set(webhook.agentSlug, list)
    }
    return { cronsByAgent: cronsMap, webhooksByAgent: webhooksMap }
  }, [cardHealth])

  const commitLayout = (
    layout: Record<string, GridRect>,
    target: 'desktop' | 'mobile' = layoutTarget
  ) => {
    // WidgetBoard only knows about currently rendered items. Preserve saved
    // geometry for any missing item whose owning agent still exists. This
    // covers intentionally hidden cards and transiently incomplete dashboard
    // inventories without retaining entries for agents that were deleted.
    const nextLayout = { ...layout }
    const targetSavedLayout = target === 'mobile' ? savedMobileLayout : savedDesktopLayout
    for (const [id, rect] of Object.entries(targetSavedLayout ?? {})) {
      if (id in nextLayout) continue
      const ownerSlug = dashboardAgentSlugFromKey(id) ?? id
      if (agentBySlug.has(ownerSlug)) nextLayout[id] = rect
    }

    const version = ++layoutMutationVersion.current[target]
    const setLocalLayout = target === 'mobile' ? setLocalMobileLayout : setLocalDesktopLayout
    setLocalLayout(nextLayout)
    updateSettings.mutate(
      target === 'mobile'
        ? { homeGridMobileLayout: nextLayout }
        : { homeGridLayout: nextLayout },
      {
        onError: (error) => {
          toast.error('Failed to save the home layout', { description: error.message })
        },
        onSettled: () => {
          if (version === layoutMutationVersion.current[target]) setLocalLayout(null)
        },
      }
    )
  }

  const commitHiddenApps = (next: Set<string>) => {
    const version = ++hiddenMutationVersion.current
    setLocalHidden(next)
    updateSettings.mutate(
      { hiddenAppCards: [...next] },
      {
        onError: (error) => {
          toast.error('Failed to update app-card visibility', { description: error.message })
        },
        onSettled: () => {
          if (version === hiddenMutationVersion.current) setLocalHidden(null)
        },
      }
    )
  }

  const toggleAppCard = (agentSlug: string) => {
    const next = new Set(displayedHiddenApps)
    if (next.has(agentSlug)) next.delete(agentSlug)
    else next.add(agentSlug)
    if (isArranging) {
      setArrangeHiddenApps(next)
      return
    }
    commitHiddenApps(next)
  }

  const { createUntitledAgent, isPending: isCreatingAgent } = useCreateUntitledAgent()
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()
  const needsTrafficLightPadding = isElectron() && getPlatform() === 'darwin' && sidebarState === 'collapsed' && !isFullScreen

  const hasAgents = orderedAgents.length > 0
  const { openSearch } = useSearch()
  const isMac = getPlatform() === 'darwin'
  const setView = (next: 'cards' | 'graph') => {
    if (next === view) return
    if (next === 'graph') {
      setArrangeLayout(null)
      setArrangeTarget(null)
      setIsArranging(false)
    }
    void navigate({
      to: '/',
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        view: next === 'graph' ? ('graph' as const) : undefined,
      }),
    })
  }
  const beginArrange = () => {
    if (!hasAgents) return
    setArrangeLayout(null)
    setArrangeHiddenApps(new Set(hiddenApps))
    setArrangeTarget(layoutTarget)
    setIsArranging(true)
  }
  const cancelArrange = () => {
    setArrangeLayout(null)
    setArrangeHiddenApps(null)
    setArrangeTarget(null)
    setIsArranging(false)
  }
  const finishArrange = () => {
    const nextLayout = arrangeLayout
    const nextHiddenApps = arrangeHiddenApps
    const target = arrangeTarget ?? layoutTarget
    setArrangeLayout(null)
    setArrangeHiddenApps(null)
    setArrangeTarget(null)
    setIsArranging(false)
    if (nextLayout) commitLayout(nextLayout, target)
    if (
      nextHiddenApps &&
      (nextHiddenApps.size !== hiddenApps.size ||
        [...nextHiddenApps].some((agentSlug) => !hiddenApps.has(agentSlug)))
    ) {
      commitHiddenApps(nextHiddenApps)
    }
  }
  const handleBoardCommit = (layout: Record<string, GridRect>) => {
    if (isArranging) {
      setArrangeLayout(layout)
      return
    }
    commitLayout(layout, layoutTarget)
  }

  // A live breakpoint change repacks the board into a different coordinate
  // system. End the transaction instead of allowing mobile geometry to be
  // committed to the desktop setting (or vice versa).
  useEffect(() => {
    if (!isArranging || arrangeTarget === null || arrangeTarget === layoutTarget) return
    setArrangeLayout(null)
    setArrangeHiddenApps(null)
    setArrangeTarget(null)
    setIsArranging(false)
  }, [arrangeTarget, isArranging, layoutTarget])

  return (
    <div className="h-full flex flex-col">
      <header
        className={`shrink-0 flex h-12 items-center gap-2 border-b bg-background px-4 ${isElectron() ? 'app-drag-region' : ''}`}
      >
        <SidebarTrigger
          className={`app-no-drag ${needsTrafficLightPadding ? 'ml-16' : '-ml-1'}`}
        />
        <div className="flex-1 flex justify-center">
          <button
            type="button"
            onClick={openSearch}
            className="flex items-center gap-2 w-full max-w-md h-7 rounded-md border bg-muted/30 hover:bg-muted/60 transition-colors px-3 text-xs text-muted-foreground app-no-drag"
            data-testid="header-search-trigger"
          >
            <Search className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 text-left truncate">Search agents and sessions...</span>
            <kbd className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
              {isMac ? '⌘K' : 'Ctrl+K'}
            </kbd>
          </button>
        </div>
        <div className="app-no-drag flex items-center gap-0.5 rounded-md border p-0.5">
          <button
            type="button"
            onClick={() => setView('cards')}
            title="Card view"
            aria-pressed={view === 'cards'}
            data-testid="home-view-cards"
            className={`rounded p-1 transition-colors ${view === 'cards' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setView('graph')}
            title="Graph view"
            aria-pressed={view === 'graph'}
            data-testid="home-view-graph"
            className={`rounded p-1 transition-colors ${view === 'graph' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Waypoints className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {view === 'graph' ? (
        <div className="min-h-0 flex-1">
          {agentsLoading ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : hasAgents ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              }
            >
              <AgentGraph />
            </Suspense>
          ) : (
            <div
              className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground"
              data-testid="graph-empty-state"
            >
              <Waypoints className="h-8 w-8" />
              <p className="text-sm">No agents yet — the graph lights up once you create one.</p>
              <Button size="sm" onClick={() => { void createUntitledAgent() }} disabled={isCreatingAgent}>
                <Plus className="h-4 w-4 mr-1" />
                New Agent
              </Button>
            </div>
          )}
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto px-4 py-6 md:p-6">
        <div className="max-w-7xl mx-auto space-y-8">
          {/* Mobile web/PWA only — "Install Gamut" prompt; renders nothing on desktop/Electron. */}
          <PwaInstallBanner />

          {/* Agents Section */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-1">
                <h2 className="text-lg font-medium">Your Agents</h2>
                {!isArranging && <HomeArrangeMenu onArrange={beginArrange} disabled={!hasAgents} />}
              </div>
              {isArranging ? (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={cancelArrange}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={finishArrange}>
                    Done
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  onClick={() => { void createUntitledAgent() }}
                  className="app-no-drag"
                  disabled={isCreatingAgent}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  New Agent
                </Button>
              )}
            </div>

            {agentsLoading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : hasAgents ? (
              <WidgetBoard
                items={widgetItems}
                onCommit={handleBoardCommit}
                arranging={isArranging}
                dragEnabled={!isMobile || isArranging}
                disableContextMenu={isMobile && isArranging}
                renderItem={(id, size, onResize) => {
                  const dash = dashboardsById.get(id)
                  if (dash) {
                    return (
                      <div className="relative h-full transition-transform duration-150 group-hover/widget:-translate-y-0.5">
                        <DashboardCard dashboard={dash.dashboard} agentSlug={dash.agentSlug} variant="fill" align={size === 'S' ? 'top-left' : 'top'} />
                        <div className="absolute right-4 top-2 z-30 flex h-[26px] items-center">
                          <WidgetSizePopover size={size} onPick={onResize} />
                        </div>
                      </div>
                    )
                  }
                  const agent = agentBySlug.get(id)
                  if (!agent) return null
                  return (
                    <AgentCard
                      agent={agent}
                      size={size}
                      onArrange={beginArrange}
                      disableTouchLongPress={isMobile && isArranging}
                      additionalOptions={
                        <>
                          <ContextMenuSwitchItem
                            checked={size === 'W'}
                            onCheckedChange={() => {
                              onResize(size === 'W' ? 'S' : 'W')
                            }}
                          >
                            Expanded
                          </ContextMenuSwitchItem>
                          {agentsWithApp.has(agent.slug) && (
                            <ContextMenuSwitchItem
                              checked={!displayedHiddenApps.has(agent.slug)}
                              onCheckedChange={() => {
                                toggleAppCard(agent.slug)
                              }}
                            >
                              Show app
                            </ContextMenuSwitchItem>
                          )}
                        </>
                      }
                      crons={cronsByAgent.get(agent.slug)}
                      webhooks={webhooksByAgent.get(agent.slug)}
                      health={cardHealth}
                    />
                  )
                }}
              />
            ) : (
              <div className="text-center py-12 border rounded-lg bg-muted/30">
                <Bot className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground mb-4">No agents yet</p>
                <Button onClick={() => { void createUntitledAgent() }} disabled={isCreatingAgent}>
                  <Plus className="h-4 w-4 mr-1" />
                  Create your first agent
                </Button>
              </div>
            )}
          </section>
        </div>
      </div>
      )}
    </div>
  )
}
