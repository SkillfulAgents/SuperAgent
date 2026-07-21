
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useSearch as useRouteSearch } from '@tanstack/react-router'
import { WidgetBoard, WidgetSizePopover, WidgetToggleRow, type GridRect, type WidgetItem, type WidgetSizeKey } from './widget-grid'
import { useAgents, useStartAgent, useStopAgent } from '@renderer/hooks/use-agents'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { useMarkSessionNotificationsRead } from '@renderer/hooks/use-notifications'
import { useAgentActivityStats } from '@renderer/hooks/use-activity-stats'
import { applyAgentOrder } from '@renderer/lib/agent-ordering'
import { useSessions } from '@renderer/hooks/use-sessions'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { Halftone } from '@renderer/components/agents/halftone'
import {
  ActivitySparkChart,
  ActivitySparkChartSkeleton,
  CronSparkChart,
  summarizeDailyActivity,
} from '@renderer/components/activity/activity-spark-chart'
import { DEFAULT_ACTIVITY_DAYS } from '@shared/lib/types/activity'
import {
  homeGraphSchema,
  type HomeGraphCron,
  type HomeGraphData,
  type HomeGraphWebhook,
} from '@shared/lib/types/home-graph-schema'
import { getAgentActivityStatus } from '@shared/lib/types/agent-activity-status'
import { WorkingDots, AwaitingDot, UnreadDot } from '@renderer/components/agents/status-indicators'
import { AgentContextMenu } from '@renderer/components/agents/agent-context-menu'
import { useCreateUntitledAgent } from '@renderer/hooks/use-create-untitled-agent'
import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import { Button } from '@renderer/components/ui/button'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { DashboardCard } from './dashboard-card'
import { PwaInstallBanner } from './pwa-install-banner'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { Plus, Bot, Loader2, Search, Power, Square, Check, ArrowRight, LayoutGrid, Waypoints } from 'lucide-react'
import { useSearch } from '@renderer/context/search-context'
import { cn } from '@shared/lib/utils/cn'
import type { ApiAgent } from '@shared/lib/types/api'
import { formatDistanceToNow } from 'date-fns'
import { useRenderTracker } from '@renderer/lib/perf'

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
      <span
        role="button"
        tabIndex={0}
        aria-label={isRunning ? 'Stop agent' : 'Wake up agent'}
        title={isRunning ? 'Stop agent' : 'Wake up agent'}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            activate(e)
          }
        }}
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded border bg-background text-foreground shadow-sm',
          'cursor-pointer transition-colors hover:bg-muted',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          isPending && 'pointer-events-none opacity-60'
        )}
      >
        {isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : isRunning ? (
          <Square className="h-2.5 w-2.5 fill-current" />
        ) : (
          <Power className="h-2.5 w-2.5" />
        )}
      </span>
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
      role="img"
      aria-label={activityStatus}
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

/** Keyboard-activatable span — cards are <button>s, so inner controls can't be native buttons. */
function rowButtonProps(onActivate: (e: React.SyntheticEvent) => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      onActivate(e)
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        onActivate(e)
      }
    },
  }
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
    <div className="flex max-h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/50 bg-white/10 backdrop-blur-sm">
      <div className="min-h-0 overflow-y-auto px-2 py-1">
        {visible.map((s) => {
          const st = sessionState(s)
          const right = compactAgo(s.lastActivityAt) ?? ''
          return (
            <div
              key={s.id}
              className="group/row flex h-6 w-full items-center gap-2.5 text-xs"
            >
              <span {...rowButtonProps(() => open(s.id))} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left">
                <SessionStateDot state={st} />
                <span className="truncate text-foreground">
                  <span className="text-muted-foreground">{SESSION_STATE_PREFIX[st]}: </span>
                  {stripAgentPrefix(s.name, agentName)}
                </span>
              </span>
              {st === 'unread' || st === 'awaiting' ? (
                <>
                  {/* The timestamp swaps for actions on hover: unread gets
                      clear + open; needs-input has nothing to clear, just open. */}
                  <span className="shrink-0 text-muted-foreground tabular-nums group-hover/row:hidden">{right}</span>
                  <span className="hidden shrink-0 items-center gap-0.5 group-hover/row:flex">
                    {st === 'unread' && (
                      <span
                        {...rowButtonProps(() => markRead.mutate(s.id))}
                        aria-label="Mark as read"
                        title="Mark as read"
                        className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </span>
                    )}
                    <span
                      {...rowButtonProps(() => open(s.id))}
                      aria-label="Open session"
                      title="Open session"
                      className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <ArrowRight className="h-3.5 w-3.5" />
                    </span>
                  </span>
                </>
              ) : (
                <span className="shrink-0 text-muted-foreground tabular-nums">{right}</span>
              )}
            </div>
          )
        })}
        {moreCount > 0 && (
          <span
            {...rowButtonProps(() => {
              void navigate({ to: '/agents/$slug', params: { slug: agentDisplaySlug } })
            })}
            className="group/row flex h-6 w-full cursor-pointer items-center justify-end gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <span>{moreCount} more</span>
            <span className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground group-hover/row:inline-flex">
              <ArrowRight className="h-3.5 w-3.5" />
            </span>
          </span>
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
}: {
  agent: ApiAgent
  crons: HomeGraphCron[]
  webhooks: HomeGraphWebhook[]
}) {
  const navigate = useNavigate()
  // live:false — many cards mount at once; same reasoning as the graph's
  // hover cards (no poll, refetch only when stale).
  const { data: stats, isPending: statsPending } = useAgentActivityStats(agent.slug, DEFAULT_ACTIVITY_DAYS, {
    live: false,
  })

  const slides = useMemo<HealthSlide[]>(
    () => [
      ...crons.map((c) => ({ kind: 'cron' as const, id: c.id, name: c.name ?? c.scheduleExpression })),
      ...webhooks.map((w) => ({ kind: 'webhook' as const, id: w.id, name: w.name ?? w.triggerType })),
    ],
    [crons, webhooks]
  )
  const count = slides.length
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)

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
    if (statsPending) {
      chart = <ActivitySparkChartSkeleton className="h-5 w-24" />
    } else if (s.kind === 'cron') {
      const activity = stats?.cronByTaskId[s.id] ?? []
      const succeeded = activity.filter((p) => p.status === 'succeeded').length
      chart = <CronSparkChart label={s.name} data={activity} className="h-5 w-24" />
      metric = `${succeeded}/${activity.length}`
    } else {
      const activity = stats?.webhookByTriggerId[s.id] ?? []
      const { total } = summarizeDailyActivity(activity)
      chart = <ActivitySparkChart label={s.name} data={activity} className="h-5 w-24" />
      metric = `${total}/${DEFAULT_ACTIVITY_DAYS}d`
    }
    return (
      <span
        {...rowButtonProps(() => openSlide(s))}
        className="flex w-full cursor-pointer items-center gap-2 text-xs"
      >
        <span className="min-w-0 flex-1 truncate">
          <span className="text-foreground">{s.name}</span>{' '}
          <span className="text-muted-foreground">{s.kind === 'cron' ? 'Cron' : 'Webhook'}</span>
        </span>
        <span className="shrink-0">{chart}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{metric}</span>
      </span>
    )
  }

  return (
    <div
      className="mt-auto flex shrink-0 items-center gap-1.5"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* The frosted panel (title's bg-white/10 + backdrop-blur) lives on the
          container so the halftone reads softly through it and never flashes.
          A single content layer slides up inside it on each change — nothing
          underneath to bleed through. */}
      <div className="relative min-w-0 flex-1 overflow-hidden rounded-md border border-border/50 bg-white/10 backdrop-blur-sm">
        <div
          key={active.id}
          className="px-2 py-1.5 animate-in slide-in-from-bottom-full duration-300"
        >
          {renderSlide(active)}
        </div>
      </div>
      {/* Vertical position dots, outside the chip to the right */}
      {count > 1 && (
        <span className="flex shrink-0 flex-col items-center gap-1">
          {slides.map((s, i) => (
            <span
              key={s.id}
              {...rowButtonProps(() => setIndex(i))}
              aria-label={`Show health row ${i + 1} of ${count}`}
              className={cn(
                'h-[3px] w-[3px] cursor-pointer rounded-full transition-colors',
                i === index % count ? 'bg-foreground/70' : 'bg-muted-foreground/30 hover:bg-muted-foreground/60'
              )}
            />
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
      <style>{'@keyframes title-ticker{from{transform:translateX(0)}to{transform:translateX(-50%)}}'}</style>
      <div
        className="flex w-max items-center whitespace-nowrap"
        style={{ animation: 'title-ticker 14s linear infinite' }}
      >
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
  sizeControl,
  crons = [],
  webhooks = [],
}: {
  agent: ApiAgent
  size?: WidgetSizeKey
  sizeControl?: ReactNode
  crons?: HomeGraphCron[]
  webhooks?: HomeGraphWebhook[]
}) {
  useRenderTracker('AgentCard')
  const navigate = useNavigate()
  const lastWorked = agent.lastActivityAt ? formatDistanceToNow(new Date(agent.lastActivityAt), { addSuffix: true }) : null

  const isSmall = size === 'S'

  // Fetch sessions whenever there are notable ones — the Wide card lists them,
  // the Small card rotates a count into the title.
  const hasNotable = agent.hasActiveSessions || agent.hasSessionsAwaitingInput || agent.hasUnreadNotifications
  const { data: sessions } = useSessions(hasNotable ? agent.slug : null, { staleTime: 30_000 })

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
    <div className="absolute bottom-2 left-4 max-w-[calc(100%-2rem)] rounded-md bg-white/10 px-2.5 py-1 backdrop-blur-sm">
      <div className="truncate text-sm font-normal text-foreground">{agent.name}</div>
      {isSmall && notifState ? (
        <TickerTitleMeta lastWorked={lastWorked} notifCount={notifSessions.length} notifState={notifState} />
      ) : (
        <div className="truncate text-xs text-muted-foreground">Last run {lastWorked ?? 'never'}</div>
      )}
    </div>
  )

  return (
    <AgentContextMenu agent={agent}>
      <button
        onClick={() => {
          void navigate({ to: '/agents/$slug', params: { slug: agent.displaySlug } })
        }}
        className="relative flex h-full w-full flex-col gap-3 overflow-hidden rounded-lg border bg-card p-4 text-left shadow-sm transition-[box-shadow,transform,border-color] duration-150 hover:border-accent-foreground/20 group-hover/widget:-translate-y-0.5 group-hover/widget:shadow-md"
      >
        {/* Control row: status chip + size kebab share one flex row, so
            items-center vertically centers the kebab against the chip, and the
            kebab simply appears to its right on hover (right-anchored row). */}
        <div className="absolute top-2 right-4 z-30 flex items-center gap-1.5">
          <AgentCardPowerButton agent={agent} />
          {sizeControl}
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
            <div className="relative z-10 flex min-h-0 flex-1 flex-col gap-1.5 pb-11">
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
              <AgentHealthCarousel agent={agent} crons={crons} webhooks={webhooks} />
            </div>
            {titleOverlay}
          </>
        )}
      </button>
    </AgentContextMenu>
  )
}

/** Widget-grid key for a dashboard tile. Agents use their bare slug. */
const dashKey = (agentSlug: string, dashSlug: string) => `dash::${agentSlug}::${dashSlug}`

export function HomePage() {
  useRenderTracker('HomePage')
  const { data: agents, isLoading: agentsLoading } = useAgents()
  const { data: userSettings } = useUserSettings()
  const updateSettings = useUpdateUserSettings()

  // agentOrder (sidebar drag order) drives the initial flow-pack order of
  // uncustomized boards; once the user drags/resizes here, homeGridLayout wins.
  const orderedAgents = useMemo(
    () => applyAgentOrder(agents ?? [], userSettings?.agentOrder),
    [agents, userSettings?.agentOrder]
  )

  // Optimistic local layout while the homeGridLayout mutation is in flight.
  const [localLayout, setLocalLayout] = useState<Record<string, GridRect> | null>(null)
  const savedLayout = localLayout ?? userSettings?.homeGridLayout

  // Agents whose associated app/dashboard card is toggled off. localHidden is a
  // session override that wins over the server value, so the toggle takes effect
  // immediately and isn't clobbered by the post-save refetch.
  const [localHidden, setLocalHidden] = useState<Set<string> | null>(null)
  const hiddenApps = useMemo(
    () => localHidden ?? new Set(userSettings?.hiddenAppCards ?? []),
    [localHidden, userSettings?.hiddenAppCards]
  )

  const { widgetItems, dashboardsById, agentsWithApp } = useMemo(() => {
    const items: WidgetItem[] = []
    const dashes = new Map<string, { agentSlug: string; dashboard: { slug: string; name: string } }>()
    const withApp = new Set<string>()
    for (const agent of orderedAgents) {
      items.push({ id: agent.slug, rect: savedLayout?.[agent.slug], defaultSize: 'W' })
      const dashboards = Array.isArray(agent.dashboards) ? agent.dashboards : []
      if (dashboards.length > 0) withApp.add(agent.slug)
      if (hiddenApps.has(agent.slug)) continue // app card toggled off — skip its dashboard tiles
      for (const d of dashboards) {
        const id = dashKey(agent.slug, d.slug)
        items.push({ id, rect: savedLayout?.[id], defaultSize: 'S' })
        dashes.set(id, { agentSlug: agent.slug, dashboard: d })
      }
    }
    return { widgetItems: items, dashboardsById: dashes, agentsWithApp: withApp }
  }, [orderedAgents, savedLayout, hiddenApps])

  const agentBySlug = useMemo(() => new Map(orderedAgents.map((a) => [a.slug, a])), [orderedAgents])

  // Shared topology snapshot for the cards' health carousels (cron/webhook
  // names per agent in one request). Same query key as the graph view, so
  // cards⇄graph flips reuse the cache; parsed at the boundary like the graph.
  const { data: topology } = useQuery<HomeGraphData>({
    queryKey: ['home-graph'],
    queryFn: async () => {
      const res = await apiFetch('/api/home-graph')
      if (!res.ok) throw new Error('Failed to fetch home graph')
      return homeGraphSchema.parse(await res.json())
    },
    staleTime: 60_000,
  })
  const { cronsByAgent, webhooksByAgent } = useMemo(() => {
    const cronsMap = new Map<string, HomeGraphCron[]>()
    const webhooksMap = new Map<string, HomeGraphWebhook[]>()
    for (const cron of topology?.crons ?? []) {
      if (cron.status === 'cancelled') continue
      const list = cronsMap.get(cron.agentSlug) ?? []
      list.push(cron)
      cronsMap.set(cron.agentSlug, list)
    }
    for (const webhook of topology?.webhooks ?? []) {
      if (webhook.status === 'cancelled') continue
      const list = webhooksMap.get(webhook.agentSlug) ?? []
      list.push(webhook)
      webhooksMap.set(webhook.agentSlug, list)
    }
    return { cronsByAgent: cronsMap, webhooksByAgent: webhooksMap }
  }, [topology])

  const commitLayout = (layout: Record<string, GridRect>) => {
    setLocalLayout(layout)
    updateSettings.mutate({ homeGridLayout: layout }, { onSettled: () => setLocalLayout(null) })
  }

  const toggleAppCard = (agentSlug: string) => {
    const next = new Set(hiddenApps)
    if (next.has(agentSlug)) next.delete(agentSlug)
    else next.add(agentSlug)
    setLocalHidden(next)
    updateSettings.mutate({ hiddenAppCards: [...next] })
  }

  const { createUntitledAgent, isPending: isCreatingAgent } = useCreateUntitledAgent()
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()
  const needsTrafficLightPadding = isElectron() && getPlatform() === 'darwin' && sidebarState === 'collapsed' && !isFullScreen

  const hasAgents = orderedAgents.length > 0
  const { openSearch } = useSearch()
  const isMac = getPlatform() === 'darwin'
  // Cards vs. graph view — URL-driven (`/?view=graph`) so back/forward
  // navigation and reloads restore the selection; absent = cards.
  const navigate = useNavigate()
  const routeSearch = useRouteSearch({ strict: false }) as { view?: string }
  const view: 'cards' | 'graph' = routeSearch.view === 'graph' ? 'graph' : 'cards'
  const setView = (next: 'cards' | 'graph') => {
    if (next === view) return
    void navigate({
      to: '/',
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        view: next === 'graph' ? ('graph' as const) : undefined,
      }),
    })
  }

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
              <h2 className="text-lg font-semibold">Your Agents</h2>
              <Button
                size="sm"
                onClick={() => { void createUntitledAgent() }}
                className="app-no-drag"
                disabled={isCreatingAgent}
              >
                <Plus className="h-4 w-4 mr-1" />
                New Agent
              </Button>
            </div>

            {agentsLoading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : hasAgents ? (
              <WidgetBoard
                items={widgetItems}
                onCommit={commitLayout}
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
                  const sizeControl = (
                    <WidgetSizePopover
                      size={size}
                      onPick={onResize}
                      extra={(close) =>
                        agentsWithApp.has(agent.slug) ? (
                          <WidgetToggleRow
                            label="Show app"
                            checked={!hiddenApps.has(agent.slug)}
                            onToggle={() => {
                              close()
                              toggleAppCard(agent.slug)
                            }}
                          />
                        ) : null
                      }
                    />
                  )
                  return (
                    <AgentCard
                      agent={agent}
                      size={size}
                      sizeControl={sizeControl}
                      crons={cronsByAgent.get(agent.slug)}
                      webhooks={webhooksByAgent.get(agent.slug)}
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
