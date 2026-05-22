
import { useMemo } from 'react'
import { useAgents, useStartAgent, useStopAgent } from '@renderer/hooks/use-agents'
import { useUserSettings } from '@renderer/hooks/use-user-settings'
import { applyAgentOrder } from '@renderer/lib/agent-ordering'
import { useUsageData } from '@renderer/hooks/use-usage'
import { useSessions } from '@renderer/hooks/use-sessions'
import { useSelection } from '@renderer/context/selection-context'
import { DotMatrix, type DotMatrixPattern } from '@renderer/components/agents/dot-matrix'
import { UptimeBars, type UptimeRun, type UptimeRunStatus } from '@renderer/components/agents/uptime-bars'
import { getAgentActivityStatus } from '@shared/lib/types/agent-activity-status'
import { WorkingDots, AwaitingDot, UnreadDot } from '@renderer/components/agents/status-indicators'
import { AgentContextMenu } from '@renderer/components/agents/agent-context-menu'
import { useCreateUntitledAgent } from '@renderer/hooks/use-create-untitled-agent'
import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import { Button } from '@renderer/components/ui/button'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { DashboardCard } from './dashboard-card'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { Plus, Bot, Loader2, Clock, CalendarClock, SquareMousePointer, Search, Power, Square } from 'lucide-react'
import { useSearch } from '@renderer/context/search-context'
import { BarChart, Bar } from 'recharts'
import { ChartContainer, ChartTooltip, type ChartConfig } from '@renderer/components/ui/chart'
import { cn } from '@shared/lib/utils/cn'
import type { ApiAgent } from '@shared/lib/types/api'
import type { DailyUsageEntry } from '@shared/lib/types/usage'
import { useRenderTracker } from '@renderer/lib/perf'

export function formatRelativeTime(date: Date | string | null | undefined): string | null {
  if (!date) return null
  const now = Date.now()
  const then = new Date(date).getTime()
  const diffMs = now - then
  const absDiff = Math.abs(diffMs)
  const isFuture = diffMs < 0

  if (absDiff < 60_000) return 'just now'
  const mins = Math.floor(absDiff / 60_000)
  if (mins < 60) return isFuture ? `in ${mins}m` : `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return isFuture ? `in ${hours}h` : `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return isFuture ? `in ${days}d` : `${days}d ago`
  const months = Math.floor(days / 30)
  return isFuture ? `in ${months}mo` : `${months}mo ago`
}

// MOCK: generate fake daily token usage when real data is empty.
// Deterministic from slug so a given agent's chart is stable across renders.
function mockSparkData(agentSlug: string, days: number) {
  const points: { date: string; tokens: number }[] = []
  const now = Date.now()
  let seed = hashSlug(agentSlug)
  // xorshift32 for pseudo-random per-day values.
  const next = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 0xffffffff
  }
  // Each agent has a baseline activity level so chart heights vary card-to-card.
  const baseline = 30_000 + next() * 250_000
  const burstChance = 0.15 + next() * 0.2
  const idleChance = 0.18 + next() * 0.15
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const roll = next()
    let tokens = 0
    if (roll < idleChance) {
      tokens = 0
    } else if (roll < idleChance + burstChance) {
      tokens = Math.round(baseline * (1.5 + next() * 2))
    } else {
      tokens = Math.round(baseline * (0.2 + next() * 0.9))
    }
    points.push({ date, tokens })
  }
  return points
}

/** Extract per-agent daily cost from the global usage data, falling back to
 *  mock data when there's no real usage to show. */
function useAgentUsageSpark(agentSlug: string, dailyUsage: DailyUsageEntry[] | undefined) {
  return useMemo(() => {
    const days = dailyUsage?.length ?? 60
    if (!dailyUsage?.length) return mockSparkData(agentSlug, days)
    const points = dailyUsage.map((day) => {
      const agentEntry = day.byAgent.find((a) => a.agentSlug === agentSlug)
      return { date: day.date, tokens: agentEntry?.totalTokens ?? 0 }
    })
    if (points.every((p) => p.tokens === 0)) return mockSparkData(agentSlug, days)
    return points
  }, [agentSlug, dailyUsage])
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`
  return String(tokens)
}

const sparkChartConfig = {
  tokens: { label: 'Tokens', color: 'hsl(var(--primary))' },
} satisfies ChartConfig

const CHART_HEIGHT_PX = 24

function UsageSparkBackground({ data }: { data: { date: string; tokens: number }[]; agentSlug: string }) {
  // Days with usage render the real bar; days with zero render a 2px floor
  // placeholder in a lighter color. Either-or, never stacked together.
  const maxTokens = data.reduce((m, d) => Math.max(m, d.tokens), 0)
  const floorValue = maxTokens > 0 ? (maxTokens * 2) / CHART_HEIGHT_PX : 1
  const series = data.map((d) => ({
    date: d.date,
    tokens: d.tokens,
    bar: d.tokens > 0 ? d.tokens : 0,
    floor: d.tokens === 0 ? floorValue : 0,
  }))
  return (
    <ChartContainer
      config={sparkChartConfig}
      // Strip `aspect-video` so the chart fills the row's height instead of
      // forcing 16:9.
      className="!aspect-auto h-full w-full"
      style={{ height: CHART_HEIGHT_PX }}
    >
      <BarChart
        data={series}
        margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
        barCategoryGap={1}
      >
        <ChartTooltip
          cursor={false}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null
            const d = payload[0].payload as { date: string; tokens: number }
            return (
              <div className="rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
                <div className="font-medium">{d.date}</div>
                <div className="text-muted-foreground tabular-nums">
                  {formatTokenCount(d.tokens)} tokens
                </div>
              </div>
            )
          }}
        />
        {/* Either the real bar OR the 2px floor renders per day — never both.
            Same stackId so they occupy the same x-slot at the same baseline. */}
        <Bar
          dataKey="floor"
          stackId="usage"
          fill="var(--color-tokens)"
          fillOpacity={0.2}
          isAnimationActive={false}
        />
        <Bar
          dataKey="bar"
          stackId="usage"
          fill="var(--color-tokens)"
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  )
}

const AGENT_CARD_MATRIX: Record<
  ReturnType<typeof getAgentActivityStatus>,
  { pattern: DotMatrixPattern; dotClassName: string }
> = {
  sleeping: { pattern: 'pulse', dotClassName: 'bg-muted-foreground/40' },
  idle: { pattern: 'pulse', dotClassName: 'bg-muted-foreground' },
  working: { pattern: 'march', dotClassName: 'bg-foreground' },
  awaiting_input: { pattern: 'blink', dotClassName: 'bg-orange-500' },
}

// Idle gets per-agent variation so the homepage doesn't pulse in unison.
// Each agent slug deterministically maps to a pattern, slow-down factor, and
// phase offset, giving cards distinct but stable "personalities."
const IDLE_PATTERNS: DotMatrixPattern[] = ['pulse', 'sweep', 'scatter']

function hashSlug(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h
}

// ---- MOCK: per-trigger uptime bars ---------------------------------------
// Pure visual placeholder while we figure out the real trigger/runs wiring.
// Each agent gets 1–3 fake triggers, deterministic from its slug.
const MOCK_LABELS = ['Daily digest', 'Inbox sweep', 'Refresh metrics', 'Weekly review', 'Backup sync', 'Pulse check']
const UPTIME_BAR_COUNT = 14

function mockUptimeRows(slug: string): { id: string; label: string; runs: UptimeRun[] }[] {
  const h = hashSlug(slug)
  const rowCount = 1 + (h % 3) // 1..3 triggers per agent
  const rows: { id: string; label: string; runs: UptimeRun[] }[] = []
  const now = Date.now()
  for (let r = 0; r < rowCount; r++) {
    const rowSeed = (h ^ ((r + 1) * 2654435761)) >>> 0
    const label = MOCK_LABELS[(rowSeed >>> 8) % MOCK_LABELS.length]
    const runs: UptimeRun[] = []
    for (let i = 0; i < UPTIME_BAR_COUNT; i++) {
      const bit = (rowSeed >>> i) & 0x1f
      let status: UptimeRunStatus
      if (bit < 22) status = 'success'
      else if (bit < 26) status = 'awaiting'
      else if (bit < 28) status = 'failed'
      else status = 'empty'
      // Bars read left→right oldest→newest; rightmost is most recent.
      const ageDays = UPTIME_BAR_COUNT - 1 - i
      runs.push({
        status,
        sessionId: status === 'empty' ? undefined : `mock-${slug}-${r}-${i}`,
        startedAt: status === 'empty' ? undefined : new Date(now - ageDays * 24 * 60 * 60 * 1000),
      })
    }
    rows.push({ id: `${slug}-mock-${r}`, label, runs })
  }
  return rows
}
// --------------------------------------------------------------------------

function idleVariation(slug: string) {
  const h = hashSlug(slug)
  const pattern = IDLE_PATTERNS[h % IDLE_PATTERNS.length]
  // Slow factor: 2.2..3.6× the base period — roughly 5–9s loops.
  const slowFactor = 2.2 + ((h >>> 4) % 100) / 100 * 1.4
  // Phase offset: 0..1 of the period, so cards desync.
  const phaseOffset = ((h >>> 12) % 100) / 100
  return { pattern, speedMultiplier: slowFactor, phaseOffset }
}

function AgentCardPowerButton({ agent }: { agent: ApiAgent }) {
  const startAgent = useStartAgent()
  const stopAgent = useStopAgent()
  const isRunning = agent.status === 'running'
  const isPending = isRunning ? stopAgent.isPending : startAgent.isPending

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
        'absolute top-2 right-2 z-20',
        'inline-flex items-center justify-center shrink-0',
        'h-6 w-6 rounded-md border bg-card text-muted-foreground',
        'transition-colors cursor-pointer',
        'hover:border-accent-foreground/30 hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isPending && 'opacity-60 pointer-events-none'
      )}
    >
      {isPending ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : isRunning ? (
        <Square className="h-3 w-3 fill-current" />
      ) : (
        <Power className="h-3 w-3" />
      )}
    </span>
  )
}

function AgentCardMatrix({
  slug,
  status,
  hasActiveSessions,
  hasSessionsAwaitingInput,
}: {
  slug: string
  status: 'running' | 'stopped'
  hasActiveSessions: boolean
  hasSessionsAwaitingInput: boolean
}) {
  const activityStatus = getAgentActivityStatus(status, hasActiveSessions, hasSessionsAwaitingInput)
  const cfg = AGENT_CARD_MATRIX[activityStatus]
  // Idle gets pattern variation + slow factor. Sleeping always pulses but slower
  // still and with a per-agent phase offset so cards don't breathe in lockstep.
  let pattern = cfg.pattern
  let speedMultiplier = 1
  let phaseOffset = 0
  if (activityStatus === 'idle') {
    const v = idleVariation(slug)
    pattern = v.pattern
    speedMultiplier = v.speedMultiplier
    phaseOffset = v.phaseOffset
  } else if (activityStatus === 'sleeping') {
    const h = hashSlug(slug)
    speedMultiplier = 1.5 + ((h >>> 4) % 100) / 100 * 0.8 // 1.5–2.3× → ~4–6s loops
    phaseOffset = ((h >>> 12) % 100) / 100
  }
  return (
    <DotMatrix
      pattern={pattern}
      size={5}
      cellPx={4}
      dotPx={2}
      dotClassName={cfg.dotClassName}
      ariaLabel={activityStatus}
      speedMultiplier={speedMultiplier}
      phaseOffset={phaseOffset}
    />
  )
}

function AgentCard({ agent, dailyUsage }: { agent: ApiAgent; dailyUsage?: DailyUsageEntry[] }) {
  useRenderTracker('AgentCard')
  const { setAgent } = useSelection()
  const lastWorked = formatRelativeTime(agent.lastActivityAt)
  const nextRun = formatRelativeTime(agent.nextScheduledTaskAt)
  const dashboardCount = agent.dashboardCount ?? 0
  const scheduledTaskCount = agent.scheduledTaskCount ?? 0
  const sparkData = useAgentUsageSpark(agent.slug, dailyUsage)
  const totalTokens = sparkData?.reduce((sum, d) => sum + d.tokens, 0) ?? 0

  // Only fetch sessions when there are notable ones to show
  const hasNotable = agent.hasActiveSessions || agent.hasSessionsAwaitingInput || agent.hasUnreadNotifications
  const { data: sessions } = useSessions(hasNotable ? agent.slug : null, { staleTime: 30_000 })

  const notableSessions = useMemo(() => {
    if (!sessions) return []
    return sessions.filter(
      (s) => s.isActive || s.isAwaitingInput || (!s.isActive && !s.isAwaitingInput && s.hasUnreadNotifications)
    )
  }, [sessions])

  // Always show active/awaiting sessions; cap unread-only notifications at 3
  const MAX_UNREAD_ROWS = 3
  const { visibleSessions, collapsedUnreadCount } = useMemo(() => {
    const active: typeof notableSessions = []
    const unread: typeof notableSessions = []
    for (const s of notableSessions) {
      if (s.isActive || s.isAwaitingInput) {
        active.push(s)
      } else {
        unread.push(s)
      }
    }
    const shownUnread = unread.slice(0, MAX_UNREAD_ROWS)
    const collapsed = unread.length - shownUnread.length
    return { visibleSessions: [...active, ...shownUnread], collapsedUnreadCount: collapsed }
  }, [notableSessions])

  return (
    <div className="flex flex-col">
      <AgentContextMenu agent={agent}>
        <button
          onClick={() => setAgent(agent.slug)}
          className="relative text-left p-4 rounded-lg border bg-card hover:border-accent-foreground/20 transition-colors flex flex-col gap-3 z-10 overflow-hidden"
        >
          <AgentCardPowerButton agent={agent} />
          <div className="flex flex-col gap-3 flex-1">
            {/* Header: matrix + name */}
            <div className="flex items-center gap-3 min-w-0">
              <AgentCardMatrix
                slug={agent.slug}
                status={agent.status}
                hasActiveSessions={agent.hasActiveSessions ?? false}
                hasSessionsAwaitingInput={agent.hasSessionsAwaitingInput ?? false}
              />
              <span className="text-sm font-normal truncate">{agent.name}</span>
            </div>

            {/* Description */}
            {agent.description && (
              <p className="text-xs text-muted-foreground line-clamp-2">{agent.description}</p>
            )}

            {/* Token usage bar chart */}
            {sparkData && (
              <div className="w-full">
                <UsageSparkBackground data={sparkData} agentSlug={agent.slug} />
              </div>
            )}

            {/* MOCK: per-trigger uptime bars (not wired yet) */}
            <div className="flex flex-col gap-1">
              {mockUptimeRows(agent.slug).map((row) => (
                <UptimeBars
                  key={row.id}
                  runs={row.runs}
                  label={row.label}
                  onRunClick={(run) => {
                    if (run.sessionId) {
                      setAgent(agent.slug, { kind: 'session', id: run.sessionId })
                    }
                  }}
                />
              ))}
            </div>

            {/* Details row */}
            <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
              {/* Last worked */}
              {lastWorked && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {lastWorked}
                </span>
              )}

              {/* Scheduled tasks */}
              {scheduledTaskCount > 0 && (
                <span className="flex items-center gap-1" title={nextRun ? `Next run: ${nextRun}` : undefined}>
                  <CalendarClock className="h-3 w-3" />
                  {scheduledTaskCount} task{scheduledTaskCount !== 1 ? 's' : ''}
                  {nextRun && <span className="text-muted-foreground/70">&middot; {nextRun}</span>}
                </span>
              )}

              {/* Dashboard count (each dashboard also gets its own card below) */}
              {dashboardCount > 0 && (
                <span className="flex items-center gap-1">
                  <SquareMousePointer className="h-3 w-3" />
                  {dashboardCount} dashboard{dashboardCount !== 1 ? 's' : ''}
                </span>
              )}

              {/* Usage tokens */}
              {sparkData && (
                <span className="flex items-center gap-1">
                  {formatTokenCount(totalTokens)} tokens/60d
                </span>
              )}
            </div>
          </div>
        </button>
      </AgentContextMenu>

      {/* Session appendages — each tucks up behind the rounded corners of the one above */}
      {visibleSessions.map((session, i) => {
        const isAwaiting = session.isAwaitingInput
        const isWorking = session.isActive && !session.isAwaitingInput
        const hasUnread = !session.isActive && !session.isAwaitingInput && session.hasUnreadNotifications

        const colors = isAwaiting
          ? 'bg-orange-50 border-orange-200 dark:bg-orange-900 dark:border-orange-800'
          : isWorking
          ? 'bg-muted border-border'
          : 'bg-blue-50 border-blue-200 dark:bg-blue-950 dark:border-blue-800'

        return (
          <div
            key={session.id}
            className="relative px-1"
            style={{ marginTop: -6, zIndex: visibleSessions.length + 1 - i }}
          >
            <button
              onClick={() => setAgent(agent.slug, { kind: 'session', id: session.id })}
              className={`w-full flex items-center gap-2 px-3 py-1.5 pt-3 text-left text-xs border rounded-b-lg transition-colors hover:brightness-95 ${colors}`}
            >
              {isAwaiting ? (
                <AwaitingDot classic />
              ) : isWorking ? (
                <WorkingDots dotClassName="bg-foreground" classic />
              ) : hasUnread ? (
                <UnreadDot classic />
              ) : null}
              <span className="truncate font-medium">{session.name}</span>
              <span className="ml-auto shrink-0 text-muted-foreground">
                {isAwaiting ? 'needs input' : isWorking ? 'working' : 'new message'}
              </span>
            </button>
          </div>
        )
      })}

      {/* Collapsed unread notification summary */}
      {collapsedUnreadCount > 0 && (
        <div
          className="relative px-1"
          style={{ marginTop: -6, zIndex: 0 }}
        >
          <button
            onClick={() => setAgent(agent.slug)}
            className="w-full flex items-center gap-2 px-3 py-1.5 pt-3 text-left text-xs border rounded-b-lg transition-colors hover:brightness-95 bg-blue-50 border-blue-200 dark:bg-blue-950 dark:border-blue-800"
          >
            <UnreadDot classic />
            <span className="font-medium">{collapsedUnreadCount} more notification{collapsedUnreadCount !== 1 ? 's' : ''}</span>
          </button>
        </div>
      )}
    </div>
  )
}

export function HomePage() {
  useRenderTracker('HomePage')
  const { data: agents, isLoading: agentsLoading } = useAgents()
  const { data: userSettings } = useUserSettings()
  const { data: usageData } = useUsageData(60)
  const orderedAgents = useMemo(
    () => applyAgentOrder(agents ?? [], userSettings?.agentOrder),
    [agents, userSettings?.agentOrder]
  )
  const { createUntitledAgent, isPending: isCreatingAgent } = useCreateUntitledAgent()
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()
  const needsTrafficLightPadding = isElectron() && getPlatform() === 'darwin' && sidebarState === 'collapsed' && !isFullScreen

  const hasAgents = orderedAgents.length > 0
  const { openSearch } = useSearch()
  const isMac = getPlatform() === 'darwin'

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
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-8">
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
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {orderedAgents.flatMap((agent) => {
                  const dashboards = Array.isArray(agent.dashboards) ? agent.dashboards : []
                  const cells = [
                    <AgentCard key={agent.slug} agent={agent} dailyUsage={usageData?.daily} />,
                  ]
                  for (const d of dashboards) {
                    cells.push(
                      <DashboardCard
                        key={`${agent.slug}::dashboard::${d.slug}`}
                        dashboard={d}
                        agentSlug={agent.slug}
                        variant="overlay"
                      />
                    )
                  }
                  return cells
                })}
              </div>
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
    </div>
  )
}
