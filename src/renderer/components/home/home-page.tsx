
import { useMemo } from 'react'
import { useAgents } from '@renderer/hooks/use-agents'
import { useUserSettings } from '@renderer/hooks/use-user-settings'
import { applyAgentOrder } from '@renderer/lib/agent-ordering'
import { useDiscoverableAgents } from '@renderer/hooks/use-agent-templates'
import { useUsageData } from '@renderer/hooks/use-usage'
import { useSessions } from '@renderer/hooks/use-sessions'
import { useSelection } from '@renderer/context/selection-context'
import { AgentStatus, getAgentActivityStatus } from '@renderer/components/agents/agent-status'
import { AgentContextMenu } from '@renderer/components/agents/agent-context-menu'
import { useDialogs } from '@renderer/context/dialog-context'
import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import { Button } from '@renderer/components/ui/button'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { Popover, PopoverTrigger, PopoverContent } from '@renderer/components/ui/popover'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { Plus, Bot, Download, Loader2, Clock, CalendarClock, LayoutDashboard, CircleHelp } from 'lucide-react'
import { AreaChart, Area, ResponsiveContainer, Tooltip } from 'recharts'
import type { ApiAgent } from '@shared/lib/types/api'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'
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

/** Extract per-agent daily cost from the global usage data */
function useAgentUsageSpark(agentSlug: string, dailyUsage: DailyUsageEntry[] | undefined) {
  return useMemo(() => {
    if (!dailyUsage?.length) return null
    const points = dailyUsage.map((day) => {
      const agentEntry = day.byAgent.find((a) => a.agentSlug === agentSlug)
      return { date: day.date, tokens: agentEntry?.totalTokens ?? 0 }
    })
    if (points.every((p) => p.tokens === 0)) return null
    return points
  }, [agentSlug, dailyUsage])
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`
  return String(tokens)
}

function UsageSparkBackground({ data, agentSlug }: { data: { date: string; tokens: number }[]; agentSlug: string }) {
  // Unique gradient IDs per agent to avoid SVG ID collisions
  const fillId = `sparkFill-${agentSlug}`
  return (
    <div
      className="absolute bottom-0 left-1/3 -right-px -bottom-px h-[60%]"
      style={{ maskImage: 'linear-gradient(to right, transparent 0%, black 30%)', WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 30%)' }}
    >
      <ResponsiveContainer width="100%" height="100%">
      <AreaChart
        data={data}
        margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
      >
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.15} />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <Tooltip
          cursor={false}
          content={({ active, payload }) => {
            if (!active || !payload?.[0]) return null
            const d = payload[0].payload as { date: string; tokens: number }
            return (
              <div className="rounded border bg-popover px-2 py-1 text-xs shadow-sm">
                <span className="text-muted-foreground">{d.date}</span>{' '}
                <span className="font-medium">{formatTokenCount(d.tokens)} tokens</span>
              </div>
            )
          }}
        />
        <Area
          type="monotone"
          dataKey="tokens"
          stroke="hsl(var(--primary))"
          strokeWidth={1}
          strokeOpacity={0.3}
          fill={`url(#${fillId})`}
          isAnimationActive={false}
        />
      </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

const statusTabBg = {
  sleeping: 'bg-muted',
  idle: 'bg-blue-100 dark:bg-blue-900/40',
  working: 'bg-green-100 dark:bg-green-900/40',
  awaiting_input: 'bg-orange-100 dark:bg-orange-900/40',
} as const

function StatusTab({ status, hasActiveSessions, hasSessionsAwaitingInput }: {
  status: 'running' | 'stopped'
  hasActiveSessions: boolean
  hasSessionsAwaitingInput: boolean
}) {
  const activityStatus = getAgentActivityStatus(status, hasActiveSessions, hasSessionsAwaitingInput)
  return (
    <div className={`absolute top-0 right-4 z-20 rounded-b-md px-2.5 py-1 ${statusTabBg[activityStatus]}`}>
      <AgentStatus status={status} hasActiveSessions={hasActiveSessions} hasSessionsAwaitingInput={hasSessionsAwaitingInput} size="sm" />
    </div>
  )
}

function AgentCard({ agent, dailyUsage }: { agent: ApiAgent; dailyUsage?: DailyUsageEntry[] }) {
  useRenderTracker('AgentCard')
  const { selectAgent, selectSession } = useSelection()
  const lastWorked = formatRelativeTime(agent.lastActivityAt)
  const nextRun = formatRelativeTime(agent.nextScheduledTaskAt)
  const dashboardCount = agent.dashboardCount ?? 0
  const dashboardNames = agent.dashboardNames ?? []
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
          onClick={() => selectAgent(agent.slug)}
          className="relative text-left p-4 rounded-lg border bg-card hover:border-accent-foreground/20 transition-colors flex flex-col gap-3 z-10 h-24 overflow-hidden"
        >
          {/* Spark chart background */}
          {sparkData && <UsageSparkBackground data={sparkData} agentSlug={agent.slug} />}

          {/* Status tab dropping from top-right */}
          <StatusTab
            status={agent.status}
            hasActiveSessions={agent.hasActiveSessions ?? false}
            hasSessionsAwaitingInput={agent.hasSessionsAwaitingInput ?? false}
          />

          {/* Content sits above the chart */}
          <div className="relative z-10 flex flex-col gap-3 flex-1 justify-between">
            {/* Header: name */}
            <div className="flex items-center gap-2 min-w-0 pr-20">
              <span className="font-medium truncate">{agent.name}</span>
            </div>

            {/* Description */}
            {agent.description && (
              <p className="text-xs text-muted-foreground line-clamp-2">{agent.description}</p>
            )}

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

              {/* Dashboards */}
              {dashboardCount > 0 && (
                <DashboardChips names={dashboardNames} slugs={agent.dashboardSlugs ?? []} agentSlug={agent.slug} />
              )}

              {/* Usage tokens */}
              {sparkData && (
                <span className="flex items-center gap-1">
                  {formatTokenCount(totalTokens)} tokens/7d
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
          ? 'bg-orange-50 border-orange-200 dark:bg-orange-950/30 dark:border-orange-800'
          : isWorking
          ? 'bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800'
          : 'bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-800'

        return (
          <div
            key={session.id}
            className="relative px-1"
            style={{ marginTop: -6, zIndex: visibleSessions.length + 1 - i }}
          >
            <button
              onClick={() => { selectAgent(agent.slug); selectSession(session.id) }}
              className={`w-full flex items-center gap-2 px-3 py-1.5 pt-3 text-left text-xs border rounded-b-lg transition-colors hover:brightness-95 ${colors}`}
            >
              {isAwaiting ? (
                <CircleHelp className="h-3 w-3 shrink-0 text-orange-500" />
              ) : isWorking ? (
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
              ) : hasUnread ? (
                <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />
              ) : null}
              <span className="truncate font-medium">{session.name}</span>
              <span className="ml-auto shrink-0 text-muted-foreground">
                {isAwaiting ? 'awaiting input' : isWorking ? 'working' : 'new message'}
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
            onClick={() => selectAgent(agent.slug)}
            className="w-full flex items-center gap-2 px-3 py-1.5 pt-3 text-left text-xs border rounded-b-lg transition-colors hover:brightness-95 bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-800"
          >
            <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />
            <span className="font-medium">{collapsedUnreadCount} more notification{collapsedUnreadCount !== 1 ? 's' : ''}</span>
          </button>
        </div>
      )}
    </div>
  )
}

function DashboardChips({ names, slugs, agentSlug }: { names: string[]; slugs: string[]; agentSlug: string }) {
  const { selectAgent, selectDashboard } = useSelection()

  const handleClick = (e: React.MouseEvent, slug: string) => {
    e.stopPropagation()
    e.preventDefault()
    selectAgent(agentSlug)
    selectDashboard(slug)
  }

  if (names.length <= 2) {
    return (
      <span className="flex items-center gap-1">
        {names.map((name, i) => (
          <span
            key={slugs[i] ?? name}
            role="button"
            tabIndex={0}
            onClick={(e) => handleClick(e, slugs[i])}
            onKeyDown={(e) => { if (e.key === 'Enter') handleClick(e as unknown as React.MouseEvent, slugs[i]) }}
            className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-2xs font-medium hover:bg-muted-foreground/20 cursor-pointer"
          >
            <LayoutDashboard className="h-2.5 w-2.5" />
            {name}
          </span>
        ))}
      </span>
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer text-xs text-muted-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          <LayoutDashboard className="h-3 w-3" />
          {names.length} dashboards
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-2" align="start" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col gap-0.5">
          {names.map((name, i) => (
            <button
              key={slugs[i] ?? name}
              onClick={(e) => handleClick(e, slugs[i])}
              className="text-left text-xs px-2 py-1 rounded hover:bg-muted"
            >
              {name}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function TemplateCard({ template, onClick }: { template: ApiDiscoverableAgent; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-left p-4 rounded-lg border border-dashed bg-card hover:bg-accent/50 transition-colors flex flex-col gap-2"
    >
      <div className="flex items-center gap-2">
        <Download className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="font-medium truncate">{template.name}</span>
        <span className="text-xs text-muted-foreground shrink-0">v{template.version}</span>
      </div>
      {template.description && (
        <p className="text-xs text-muted-foreground line-clamp-2">{template.description}</p>
      )}
      <p className="text-xs text-muted-foreground/70">{template.skillsetName}</p>
    </button>
  )
}

export function HomePage() {
  useRenderTracker('HomePage')
  const { data: agents, isLoading: agentsLoading } = useAgents()
  const { data: userSettings } = useUserSettings()
  const { data: discoverableAgents } = useDiscoverableAgents()
  const { data: usageData } = useUsageData(7)
  const orderedAgents = useMemo(
    () => applyAgentOrder(agents ?? [], userSettings?.agentOrder),
    [agents, userSettings?.agentOrder]
  )
  const { openCreateAgent } = useDialogs()
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()
  const needsTrafficLightPadding = isElectron() && getPlatform() === 'darwin' && sidebarState === 'collapsed' && !isFullScreen

  const hasAgents = orderedAgents.length > 0
  const hasTemplates = discoverableAgents && discoverableAgents.length > 0

  return (
    <div className="h-full flex flex-col">
      <header
        className={`shrink-0 flex h-12 items-center gap-2 border-b bg-background px-4 ${isElectron() ? 'app-drag-region' : ''}`}
      >
        <SidebarTrigger
          className={`app-no-drag ${needsTrafficLightPadding ? 'ml-16' : '-ml-1'}`}
        />
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-8">
          {/* Agents Section */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Your Agents</h2>
              <Button
                size="sm"
                onClick={() => openCreateAgent()}
                className="app-no-drag"
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
                {orderedAgents.map((agent) => (
                  <AgentCard key={agent.slug} agent={agent} dailyUsage={usageData?.daily} />
                ))}
              </div>
            ) : (
              <div className="text-center py-12 border rounded-lg bg-muted/30">
                <Bot className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground mb-4">No agents yet</p>
                <Button onClick={() => openCreateAgent()}>
                  <Plus className="h-4 w-4 mr-1" />
                  Create your first agent
                </Button>
              </div>
            )}
          </section>

          {/* Templates Section */}
          {hasTemplates && (
            <section>
              <h2 className="text-lg font-semibold mb-4">Agent Templates</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {discoverableAgents.map((template) => (
                  <TemplateCard
                    key={`${template.skillsetId}::${template.path}`}
                    template={template}
                    onClick={() => openCreateAgent(template)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
