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
import type { ContainerStatus } from '@shared/lib/container/types'

interface AgentHeaderProps {
  slug: string
  isViewOnly: boolean
  startAgent: ReturnType<typeof useStartAgent>
  stopAgent: ReturnType<typeof useStopAgent>
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
  const apiLogsOpen = view.kind === 'apiLogs'
  const secretsOpen = view.kind === 'secrets'
  const connectionsOpen = view.kind === 'connections'

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

  return (
    <>
      <div className="flex flex-col md:flex-row md:items-center gap-0 md:gap-1.5 min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          {agent ? (
            <AgentContextMenu agent={agent}>
              <AppLink
                to="/agents/$slug"
                params={{ slug }}
                activeOptions={{ exact: true }}
                noDrag
                // Route-derived leaf styling: foreground only when this link is the
                // exact active route (`data-status=active`), muted/clickable otherwise.
                className="text-sm font-light truncate transition-colors text-muted-foreground hover:text-foreground data-[status=active]:text-foreground cursor-context-menu"
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
              className="text-sm font-light truncate transition-colors text-muted-foreground hover:text-foreground data-[status=active]:text-foreground"
              data-testid="agent-breadcrumb"
            >
              Loading...
            </AppLink>
          )}
        </div>
        {(() => {
          const taskCrumbId = scheduledTaskId ?? (sessionId ? session?.scheduledTaskId ?? null : null)
          const taskCrumbName = scheduledTask?.name ?? (sessionId ? session?.scheduledTaskName : null)
          if (!taskCrumbId) return null
          const isLeaf = !!scheduledTaskId
          return (
            <div className="flex items-center gap-1.5 min-w-0">
              <span aria-hidden="true" className="text-sm font-light text-muted-foreground shrink-0 hidden md:block">/</span>
              {isLeaf ? (
                <span className="flex items-center gap-1 text-muted-foreground app-no-drag">
                  <Clock className="h-4 w-4" />
                  <span className="truncate text-sm font-light text-foreground">
                    {taskCrumbName || 'Scheduled Task'}
                  </span>
                </span>
              ) : (
                <AppLink
                  to="/agents/$slug/tasks/$taskId"
                  params={{ slug, taskId: taskCrumbId }}
                  noDrag
                  className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Clock className="h-4 w-4" />
                  <span className="truncate text-sm font-light">
                    {taskCrumbName || 'Scheduled Task'}
                  </span>
                </AppLink>
              )}
            </div>
          )
        })()}
        {(() => {
          const webhookCrumbId = webhookTriggerId ?? (sessionId ? session?.webhookTriggerId ?? null : null)
          const webhookCrumbName = webhookTrigger?.name ?? webhookTrigger?.triggerType ?? (sessionId ? session?.webhookTriggerName : null)
          if (!webhookCrumbId) return null
          const isLeaf = !!webhookTriggerId
          return (
            <div className="flex items-center gap-1.5 min-w-0">
              <span aria-hidden="true" className="text-sm font-light text-muted-foreground shrink-0 hidden md:block">/</span>
              {isLeaf ? (
                <span className="flex items-center gap-1 text-muted-foreground app-no-drag">
                  <Zap className="h-4 w-4" />
                  <span className="truncate text-sm font-light text-foreground">
                    {webhookCrumbName || 'Webhook Trigger'}
                  </span>
                </span>
              ) : (
                <AppLink
                  to="/agents/$slug/webhooks/$webhookId"
                  params={{ slug, webhookId: webhookCrumbId }}
                  noDrag
                  className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Zap className="h-4 w-4" />
                  <span className="truncate text-sm font-light">
                    {webhookCrumbName || 'Webhook Trigger'}
                  </span>
                </AppLink>
              )}
            </div>
          )
        })()}
        {sessionId && session?.agentSlug === agent?.slug && (
          <div className="flex items-center gap-1.5 min-w-0">
            <span aria-hidden="true" className="text-sm font-light text-muted-foreground shrink-0 hidden md:block">/</span>
            <SessionContextMenu
              sessionId={sessionId}
              sessionName={session?.name || 'Session'}
              agentSlug={slug}
            >
              <span
                className="text-sm font-light text-foreground truncate cursor-context-menu app-no-drag"
                data-testid="session-breadcrumb"
              >
                {session?.name || 'Loading...'}
              </span>
            </SessionContextMenu>
          </div>
        )}
        {apiLogsOpen && (
          <div className="flex items-center gap-1.5 min-w-0">
            <span aria-hidden="true" className="text-sm font-light text-muted-foreground shrink-0 hidden md:block">/</span>
            <span className="truncate text-sm font-light text-foreground">API Logs</span>
          </div>
        )}
        {secretsOpen && (
          <div className="flex items-center gap-1.5 min-w-0">
            <span aria-hidden="true" className="text-sm font-light text-muted-foreground shrink-0 hidden md:block">/</span>
            <span className="truncate text-sm font-light text-foreground">Secrets</span>
          </div>
        )}
        {connectionsOpen && (
          <ConnectionsCrumbs
            slug={slug}
            detail={view.kind === 'connections' ? view.detail ?? null : null}
          />
        )}
      </div>
      <div className="flex items-center gap-0 md:gap-2 shrink-0 app-no-drag">
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
            <Separator orientation="vertical" className="h-5 hidden md:block ml-2" />
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
                          disabled={startAgent.isPending || !isRuntimeReady}
                          aria-label="Start Agent"
                        >
                          {isPulling || startAgent.isPending ? (
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
                startDisabled={startAgent.isPending || !isRuntimeReady}
                isStarting={isPulling || startAgent.isPending}
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

  const separator = (
    <span aria-hidden="true" className="text-sm font-light text-muted-foreground shrink-0 hidden md:block">/</span>
  )

  if (!detail) {
    return (
      <div className="flex items-center gap-1.5 min-w-0">
        {separator}
        <span className="truncate text-sm font-light text-foreground">Connections</span>
      </div>
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
        <div className="flex items-center gap-1.5 min-w-0">
          {separator}
          <AppLink
            to="/agents/$slug/connections"
            params={{ slug }}
            // No `search` → drops `?detail`/`?source`, returning to the list.
            noDrag
            className="truncate text-sm font-light text-muted-foreground hover:text-foreground transition-colors"
            data-testid="connections-breadcrumb"
          >
            Connections
          </AppLink>
        </div>
      )}
      <div className="flex items-center gap-1.5 min-w-0">
        {separator}
        {detail.view === 'logs' ? (
          <AppLink
            to="/agents/$slug/connections"
            params={{ slug }}
            search={{ detail: detail.rowKey, source: detail.source }}
            noDrag
            className="truncate text-sm font-light text-muted-foreground hover:text-foreground transition-colors"
          >
            {connectionName}
          </AppLink>
        ) : (
          <span className="truncate text-sm font-light text-foreground">{connectionName}</span>
        )}
      </div>
      {detail.view === 'logs' && (
        <div className="flex items-center gap-1.5 min-w-0">
          {separator}
          <span className="truncate text-sm font-light text-foreground">Logs</span>
        </div>
      )}
    </>
  )
}
