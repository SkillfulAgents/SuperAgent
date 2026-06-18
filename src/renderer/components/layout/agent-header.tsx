import { Power, Square, Clock, Loader2, Zap } from 'lucide-react'
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
import { SessionContextMenu } from '@renderer/components/sessions/session-context-menu'
import { Separator } from '@renderer/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Button } from '@renderer/components/ui/button'

interface AgentHeaderProps {
  slug: string
  isViewOnly: boolean
  startAgent: ReturnType<typeof useStartAgent>
  stopAgent: ReturnType<typeof useStopAgent>
}

/**
 * The agent header chrome (breadcrumb + start/stop) rendered by the shared
 * AgentShell layout, so it stays mounted across every agent sub-view (migration
 * plan §8.1 — "AgentShell owns the agent header chrome"). Which crumbs show is
 * derived from the URL via `useRouteLocation()`; the crumbs themselves are
 * `<AppLink>`s (real `<a href>` — §7.4), so the agent-name crumb's active styling
 * is route-derived (`data-status`) and survives a cold reload with no
 * hand-computed leaf flag.
 */
export function AgentHeader({ slug, isViewOnly, startAgent, stopAgent }: AgentHeaderProps) {
  const { view } = useRouteLocation()
  const sessionId = view.kind === 'session' ? view.id : null
  const scheduledTaskId = view.kind === 'task' ? view.id : null
  const webhookTriggerId = view.kind === 'webhook' ? view.id : null
  const apiLogsOpen = view.kind === 'apiLogs'
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
          <AppLink
            to="/agents/$slug"
            params={{ slug }}
            activeOptions={{ exact: true }}
            noDrag
            // Route-derived leaf styling: foreground only when this link is the
            // exact active route (`data-status=active`), muted/clickable otherwise.
            className="text-sm font-light truncate transition-colors text-muted-foreground hover:text-foreground data-[status=active]:text-foreground"
            data-testid="agent-breadcrumb"
          >
            {agent?.name || 'Loading...'}
          </AppLink>
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
        {sessionId && session?.agentSlug === slug && (
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
        {connectionsOpen && (
          <ConnectionsCrumbs
            slug={slug}
            detail={view.kind === 'connections' ? view.detail ?? null : null}
          />
        )}
      </div>
      <div className="flex items-center gap-0 md:gap-2 shrink-0 app-no-drag">
        {agent && <AgentStatus status={agent.status} hasActiveSessions={hasActiveSessions} hasSessionsAwaitingInput={hasSessionsAwaitingInput} />}
        {!isViewOnly && (
          <>
            <Separator orientation="vertical" className="h-5 hidden md:block ml-2" />
            <div className="hidden md:flex items-center gap-2">
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
          </>
        )}
      </div>
    </>
  )
}

/**
 * Header crumbs for the Connections view. The list shows "/ Connections";
 * an open detail view appends the connection name — including the
 * "Connections" segment (clickable, back to the list) only when the detail
 * was opened from the list, so a home-card deep link reads "Agent / Account".
 */
function ConnectionsCrumbs({
  slug,
  detail,
}: {
  slug: string
  detail: { rowKey: string; source: 'home' | 'list' } | null
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
        <span className="truncate text-sm font-light text-foreground">{connectionName}</span>
      </div>
    </>
  )
}
