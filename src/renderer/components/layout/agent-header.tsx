import { Power, Square, Clock, Loader2, Zap, MoreVertical } from 'lucide-react'
import { AppLink } from '@renderer/components/ui/app-link'
import { useRouteLocation } from '@renderer/router/use-route-location'
import { useAgent, type useStartAgent, type useStopAgent } from '@renderer/hooks/use-agents'
import { useSessions, useSession } from '@renderer/hooks/use-sessions'
import { useScheduledTask } from '@renderer/hooks/use-scheduled-tasks'
import { useWebhookTrigger } from '@renderer/hooks/use-webhook-triggers'
import { useConnectedAccounts } from '@renderer/hooks/use-connected-accounts'
import { useRemoteMcps } from '@renderer/hooks/use-remote-mcps'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { AgentStatus } from '@renderer/components/agents/agent-status'
import { AgentContextMenu } from '@renderer/components/agents/agent-context-menu'
import { SessionContextMenu } from '@renderer/components/sessions/session-context-menu'
import { Separator } from '@renderer/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@renderer/components/ui/popover'
import { HoverScrollText } from '@renderer/components/ui/hover-scroll-text'
import { useDashboardHeader } from '@renderer/context/dashboard-header-context'
import { DashboardHeaderActions } from '@renderer/components/dashboards/dashboard-header-actions'
import type { ContainerStatus } from '@shared/lib/container/types'
import { ScrollAwareNavTitle } from './scroll-aware-title'

interface AgentHeaderProps {
  slug: string
  isViewOnly: boolean
  startAgent: ReturnType<typeof useStartAgent>
  stopAgent: ReturnType<typeof useStopAgent>
}

function BreadcrumbSeparator() {
  return (
    <span aria-hidden="true" className="mx-1.5 text-sm font-light text-muted-foreground">
      /
    </span>
  )
}

/**
 * The agent header chrome (breadcrumb + start/stop) rendered by the shared
 * AgentShell layout, so it stays mounted across every agent sub-view. Which
 * crumbs show is derived from the URL via `useRouteLocation()`; the crumbs
 * themselves are `<AppLink>`s (real `<a href>`), so the agent-name crumb's
 * active styling is route-derived (`data-status`) and survives a cold reload
 * with no hand-computed leaf flag.
 */
export function AgentHeader({ slug, isViewOnly, startAgent, stopAgent }: AgentHeaderProps) {
  const { view } = useRouteLocation()
  const sessionId = view.kind === 'session' ? view.id : null
  const scheduledTaskId = view.kind === 'task' ? view.id : null
  const webhookTriggerId = view.kind === 'webhook' ? view.id : null
  const inboundXAgentOpen = view.kind === 'inboundXAgent'
  const completedTasksOpen = view.kind === 'completedTasks'
  const apiLogsOpen = view.kind === 'apiLogs'
  const secretsOpen = view.kind === 'secrets'
  const xAgentPermissionsOpen = view.kind === 'xAgentPermissions'
  const connectionsOpen = view.kind === 'connections'
  const dashboardSlug = view.kind === 'dashboard' ? view.slug : null
  const dashboardHeader = useDashboardHeader(slug, dashboardSlug)

  const { data: agent } = useAgent(slug)
  const { data: sessions } = useSessions(slug)
  const { data: session } = useSession(sessionId, slug)
  const { data: scheduledTask } = useScheduledTask(scheduledTaskId)
  const { data: webhookTrigger } = useWebhookTrigger(webhookTriggerId)
  const hasActiveSessions = sessions?.some((s) => s.isActive) || (agent?.hasActiveSessions ?? false)
  const hasSessionsAwaitingInput = sessions?.some((s) => s.isAwaitingInput) || (agent?.hasSessionsAwaitingInput ?? false)
  const { data: runtimeStatus, isPending: isRuntimePending } = useRuntimeStatus()
  const readiness = runtimeStatus?.runtimeReadiness
  const isRuntimeReady = isRuntimePending || readiness?.status === 'READY'
  const isPulling = readiness?.status === 'PULLING_IMAGE'
  const apiKeyConfigured = runtimeStatus?.apiKeyConfigured !== false
  const isAgentStarting = startAgent.isPending || dashboardHeader?.isAgentStarting === true

  return (
    <>
      <div className="min-w-0 flex-1" data-testid="breadcrumb-drag-area">
        <HoverScrollText
          className="w-fit max-w-full app-no-drag"
          data-testid="breadcrumb-trail"
        >
        <ScrollAwareNavTitle>
          {agent ? (
            <AgentContextMenu agent={agent}>
              <AppLink
                to="/agents/$slug"
                params={{ slug }}
                activeOptions={{ exact: true }}
                noDrag
                // Route-derived leaf styling: foreground only when this link is the
                // exact active route (`data-status=active`), muted/clickable otherwise.
                className="text-sm font-light transition-colors text-muted-foreground hover:text-foreground data-[status=active]:text-foreground cursor-context-menu"
                data-testid="agent-breadcrumb"
              >
                {agent.name}
              </AppLink>
            </AgentContextMenu>
          ) : (
            <AppLink
              to="/agents/$slug"
              params={{ slug }}
              activeOptions={{ exact: true }}
              noDrag
              className="text-sm font-light transition-colors text-muted-foreground hover:text-foreground data-[status=active]:text-foreground"
              data-testid="agent-breadcrumb"
            >
              Loading...
            </AppLink>
          )}
        </ScrollAwareNavTitle>
        {(() => {
          const taskCrumbId = scheduledTaskId ?? (sessionId ? session?.scheduledTaskId ?? null : null)
          const taskCrumbName = scheduledTask?.name ?? (sessionId ? session?.scheduledTaskName : null)
          if (!taskCrumbId) return null
          const isLeaf = !!scheduledTaskId
          return (
            <>
              <BreadcrumbSeparator />
              {isLeaf ? (
                <span className="inline-flex items-center gap-1 align-middle text-muted-foreground app-no-drag">
                  <Clock className="h-4 w-4 shrink-0" />
                  <span className="text-sm font-light text-foreground">
                    {taskCrumbName || 'Scheduled Task'}
                  </span>
                </span>
              ) : (
                <AppLink
                  to="/agents/$slug/tasks/$taskId"
                  params={{ slug, taskId: taskCrumbId }}
                  noDrag
                  className="inline-flex items-center gap-1 align-middle text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Clock className="h-4 w-4 shrink-0" />
                  <span className="text-sm font-light">
                    {taskCrumbName || 'Scheduled Task'}
                  </span>
                </AppLink>
              )}
            </>
          )
        })()}
        {(() => {
          const webhookCrumbId = webhookTriggerId ?? (sessionId ? session?.webhookTriggerId ?? null : null)
          const webhookCrumbName = webhookTrigger?.name ?? webhookTrigger?.triggerType ?? (sessionId ? session?.webhookTriggerName : null)
          if (!webhookCrumbId) return null
          const isLeaf = !!webhookTriggerId
          return (
            <>
              <BreadcrumbSeparator />
              {isLeaf ? (
                <span className="inline-flex items-center gap-1 align-middle text-muted-foreground app-no-drag">
                  <Zap className="h-4 w-4 shrink-0" />
                  <span className="text-sm font-light text-foreground">
                    {webhookCrumbName || 'Webhook Trigger'}
                  </span>
                </span>
              ) : (
                <AppLink
                  to="/agents/$slug/webhooks/$webhookId"
                  params={{ slug, webhookId: webhookCrumbId }}
                  noDrag
                  className="inline-flex items-center gap-1 align-middle text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Zap className="h-4 w-4 shrink-0" />
                  <span className="text-sm font-light">
                    {webhookCrumbName || 'Webhook Trigger'}
                  </span>
                </AppLink>
              )}
            </>
          )
        })()}
        {sessionId && session?.invokedByAgentSlug && (
          <>
            <BreadcrumbSeparator />
            <AppLink
              to="/agents/$slug/called-from-agents"
              params={{ slug }}
              noDrag
              className="text-sm font-light text-muted-foreground hover:text-foreground transition-colors"
              data-testid="inbound-x-agent-breadcrumb"
            >
              Called from Other Agents
            </AppLink>
          </>
        )}
        {sessionId && session?.agentSlug === agent?.slug && (
          <>
            <BreadcrumbSeparator />
            <SessionContextMenu
              sessionId={sessionId}
              sessionName={session?.name || 'Session'}
              agentSlug={slug}
              sessionIsLive={!!session?.isActive || !!session?.isAwaitingInput}
            >
              <span
                className="text-sm font-light text-foreground cursor-context-menu app-no-drag"
                data-testid="session-breadcrumb"
              >
                {session?.name || 'Loading...'}
              </span>
            </SessionContextMenu>
          </>
        )}
        {dashboardSlug && (
          <>
            <BreadcrumbSeparator />
            <span
              className="text-sm font-light text-foreground app-no-drag"
              data-testid="dashboard-breadcrumb"
            >
              {dashboardHeader?.dashboardName || dashboardSlug}
            </span>
          </>
        )}
        {apiLogsOpen && (
          <>
            <BreadcrumbSeparator />
            <span className="text-sm font-light text-foreground">API Logs</span>
          </>
        )}
        {secretsOpen && (
          <>
            <BreadcrumbSeparator />
            <span className="text-sm font-light text-foreground">Secrets</span>
          </>
        )}
        {xAgentPermissionsOpen && (
          <>
            <BreadcrumbSeparator />
            <span className="text-sm font-light text-foreground">Agent-to-agent Connections</span>
          </>
        )}
        {inboundXAgentOpen && (
          <>
            <BreadcrumbSeparator />
            <span className="text-sm font-light text-foreground">Called from Other Agents</span>
          </>
        )}
        {completedTasksOpen && (
          <>
            <BreadcrumbSeparator />
            <span className="text-sm font-light text-foreground">Completed One-time Tasks</span>
          </>
        )}
        {connectionsOpen && (
          <ConnectionsCrumbs
            slug={slug}
            detail={view.kind === 'connections' ? view.detail ?? null : null}
          />
        )}
        </HoverScrollText>
      </div>
      <div className="flex items-center gap-0 md:gap-2 shrink-0 app-no-drag">
        <DashboardHeaderActions agentSlug={slug} dashboardSlug={dashboardSlug} />
        {dashboardHeader?.actions && (
          <Separator orientation="vertical" className="hidden h-5 md:block" />
        )}
        {agent && (
          <AgentStatus
            status={agent.status}
            hasActiveSessions={hasActiveSessions}
            hasSessionsAwaitingInput={hasSessionsAwaitingInput}
            // Mobile collapses the status into the kebab menu below; keep it
            // inline on desktop. View-only mode has no kebab, so it stays inline.
            className={!isViewOnly ? 'hidden md:flex' : undefined}
          />
        )}
        {!isViewOnly && (
          <>
            <Separator orientation="vertical" className="hidden h-5 md:block" />
            <div className="hidden md:flex items-center gap-2" data-testid="agent-power-controls">
              {agent?.status === 'running' ? (
                <TooltipProvider delayDuration={0}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => stopAgent.mutate(slug)}
                        disabled={stopAgent.isPending}
                        aria-label="Stop Agent"
                      >
                        <Square className="h-4 w-4 fill-current" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Stop Agent</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                <TooltipProvider delayDuration={0}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => startAgent.mutate(slug)}
                          disabled={isAgentStarting || !isRuntimeReady}
                          aria-label="Start Agent"
                        >
                          {isPulling || isAgentStarting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Power className="h-4 w-4" />
                          )}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {!apiKeyConfigured ? (
                      <TooltipContent>
                        <p>No API key configured. An administrator needs to set up the LLM API key.</p>
                      </TooltipContent>
                    ) : !isRuntimeReady && readiness ? (
                      <TooltipContent>
                        <p>{readiness.message}</p>
                        {readiness.pullProgress && readiness.pullProgress.percent != null && (
                          <p className="text-xs opacity-80">{readiness.pullProgress.status} ({readiness.pullProgress.percent}%)</p>
                        )}
                      </TooltipContent>
                    ) : (
                      <TooltipContent>
                        <p>Wake up agent</p>
                      </TooltipContent>
                    )}
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
            {/* Mobile: the inline status pill + power controls above are
                `hidden md:*`; collapse them into a kebab on small screens. */}
            {agent && (
              <AgentHeaderMobileMenu
                slug={slug}
                status={agent.status}
                hasActiveSessions={hasActiveSessions}
                hasSessionsAwaitingInput={hasSessionsAwaitingInput}
                startAgent={startAgent}
                stopAgent={stopAgent}
                startDisabled={isAgentStarting || !isRuntimeReady}
                isStarting={isPulling || isAgentStarting}
                wakeDisabledReason={
                  !apiKeyConfigured
                    ? 'No API key configured. An administrator needs to set up the LLM API key.'
                    : !isRuntimeReady
                      ? readiness?.message ?? null
                      : null
                }
              />
            )}
          </>
        )}
      </div>
    </>
  )
}

/**
 * Mobile-only kebab for the agent header. Desktop keeps the inline status pill +
 * start/stop cluster (`hidden md:*`); below `md` those collapse into this menu
 * (`md:hidden`), which surfaces the agent status plus the Start/Stop action so a
 * touch user can wake or stop the agent without a right-click or hover.
 */
function AgentHeaderMobileMenu({
  slug,
  status,
  hasActiveSessions,
  hasSessionsAwaitingInput,
  startAgent,
  stopAgent,
  startDisabled,
  isStarting,
  wakeDisabledReason,
}: {
  slug: string
  status: ContainerStatus
  hasActiveSessions: boolean
  hasSessionsAwaitingInput: boolean
  startAgent: ReturnType<typeof useStartAgent>
  stopAgent: ReturnType<typeof useStopAgent>
  startDisabled: boolean
  isStarting: boolean
  wakeDisabledReason: string | null
}) {
  const isRunning = status === 'running'
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="Agent options"
          data-testid="agent-mobile-menu"
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-52 p-1">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <AgentStatus
            status={status}
            hasActiveSessions={hasActiveSessions}
            hasSessionsAwaitingInput={hasSessionsAwaitingInput}
          />
        </div>
        <Separator className="my-1" />
        {isRunning ? (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted transition-colors disabled:pointer-events-none disabled:opacity-50"
            onClick={() => stopAgent.mutate(slug)}
            disabled={stopAgent.isPending}
          >
            <Square className="h-4 w-4 fill-current" />
            Stop Agent
          </button>
        ) : (
          <>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted transition-colors disabled:pointer-events-none disabled:opacity-50"
              onClick={() => startAgent.mutate(slug)}
              disabled={startDisabled}
            >
              {isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
              Wake up agent
            </button>
            {wakeDisabledReason && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">{wakeDisabledReason}</p>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Header crumbs for the Connections view. The list shows "/ Connections";
 * an open detail view appends the connection name — including the
 * "Connections" segment (clickable, back to the list) only when the detail
 * was opened from the list, so a home-card deep link reads "Agent / Account".
 * The logs subview makes the connection crumb clickable and appends "/ Logs".
 */
function ConnectionsCrumbs({
  slug,
  detail,
}: {
  slug: string
  detail: { rowKey: string; source: 'home' | 'list'; view?: 'logs' } | null
}) {
  const { data: accountsData } = useConnectedAccounts()
  const { data: mcpsData } = useRemoteMcps()

  if (!detail) {
    return (
      <>
        <BreadcrumbSeparator />
        <span className="text-sm font-light text-foreground">Connections</span>
      </>
    )
  }

  const accounts = Array.isArray(accountsData?.accounts) ? accountsData.accounts : []
  const mcps = Array.isArray(mcpsData?.servers) ? mcpsData.servers : []
  const connectionName =
    accounts.find((a) => `account-${a.id}` === detail.rowKey)?.displayName ??
    mcps.find((m) => `mcp-${m.id}` === detail.rowKey)?.name ??
    'Connection'

  return (
    <>
      {detail.source === 'list' && (
        <>
          <BreadcrumbSeparator />
          <AppLink
            to="/agents/$slug/connections"
            params={{ slug }}
            // No `search` → drops `?detail`/`?source`, returning to the list.
            noDrag
            className="text-sm font-light text-muted-foreground hover:text-foreground transition-colors"
            data-testid="connections-breadcrumb"
          >
            Connections
          </AppLink>
        </>
      )}
      <BreadcrumbSeparator />
      {detail.view === 'logs' ? (
        <AppLink
          to="/agents/$slug/connections"
          params={{ slug }}
          search={{ detail: detail.rowKey, source: detail.source }}
          noDrag
          className="text-sm font-light text-muted-foreground hover:text-foreground transition-colors"
        >
          {connectionName}
        </AppLink>
      ) : (
        <span className="text-sm font-light text-foreground">{connectionName}</span>
      )}
      {detail.view === 'logs' && (
        <>
          <BreadcrumbSeparator />
          <span className="text-sm font-light text-foreground">Logs</span>
        </>
      )}
    </>
  )
}
