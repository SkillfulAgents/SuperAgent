import { useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@renderer/components/ui/button'
import { ChevronRight, Plus, Settings2 } from 'lucide-react'
import { IntegrationRow } from '@renderer/components/connections/integration-row'
import { McpStatusPill } from '@renderer/components/connections/mcp-status-pill'
import { useAgentConnectedAccounts } from '@renderer/hooks/use-connected-accounts'
import { useAgentRemoteMcps, type RemoteMcpServer } from '@renderer/hooks/use-remote-mcps'
import { HomeCollapsible } from './home-collapsible'
import { formatDistanceToNow } from 'date-fns'
import { safeDate } from '@renderer/components/connections/utils'
import { COMMON_MCP_SERVERS } from '@shared/lib/mcp/common-servers'
import { FeaturedServicesStack } from '@renderer/components/connections/featured-services-stack'
import { useAgentActivityStats } from '@renderer/hooks/use-activity-stats'
import { ActivitySparkChart, ActivitySparkChartSkeleton } from '@renderer/components/activity/activity-spark-chart'
import { getProvider } from '@shared/lib/account-providers/service-catalog'
import {
  isForeignAgentConnectedAccount,
  isForeignAgentRemoteMcp,
} from '@shared/lib/agent-connections/public'

interface HomeConnectionsProps {
  agentSlug: string
  className?: string
}

interface ConnectionRow {
  /** Matches the UnifiedRow key format so it can deep-link to the detail view. */
  id: string
  name: string
  subtitle?: string
  iconSlug?: string
  iconFallback: 'oauth' | 'mcp' | 'blocks'
  type: 'oauth' | 'mcp'
  date?: string | number
  /** Opaque link owned by another member; never navigable. */
  foreign?: true
  mcpStatus?: RemoteMcpServer['status']
  mcpErrorMessage?: string | null
}

export function HomeConnections({ agentSlug, className }: HomeConnectionsProps) {
  const { data: accountsData } = useAgentConnectedAccounts(agentSlug)
  const { data: mcpsData } = useAgentRemoteMcps(agentSlug)
  const { data: activityStats, isPending: activityPending } = useAgentActivityStats(agentSlug)
  const navigate = useNavigate()

  const connections = useMemo<ConnectionRow[]>(() => {
    const rows: ConnectionRow[] = []

    const accounts = Array.isArray(accountsData?.accounts) ? accountsData.accounts : []
    for (const [index, account] of accounts.entries()) {
      if (isForeignAgentConnectedAccount(account)) {
        rows.push({
          id: `foreign-account-${account.toolkitSlug}-${index}`,
          name: getProvider(account.toolkitSlug)?.displayName ?? account.toolkitSlug,
          subtitle: 'Connected by another member',
          iconSlug: account.toolkitSlug,
          iconFallback: 'oauth',
          type: 'oauth',
          foreign: true,
        })
        continue
      }

      rows.push({
        id: `account-${account.id}`,
        name: account.provider?.displayName ?? account.toolkitSlug,
        subtitle: account.displayName,
        iconSlug: account.toolkitSlug,
        iconFallback: 'oauth',
        type: 'oauth',
        date: account.createdAt,
      })
    }

    const mcps = Array.isArray(mcpsData?.mcps) ? mcpsData.mcps : []
    for (const [index, mcp] of mcps.entries()) {
      if (isForeignAgentRemoteMcp(mcp)) {
        rows.push({
          id: `foreign-mcp-${index}`,
          name: 'Shared MCP connection',
          subtitle: 'Connected by another member',
          iconFallback: 'blocks',
          type: 'mcp',
          foreign: true,
        })
        continue
      }

      rows.push({
        id: `mcp-${mcp.id}`,
        name: mcp.name,
        subtitle: mcp.url,
        iconSlug: COMMON_MCP_SERVERS.find((cs) => cs.url === mcp.url)?.slug,
        iconFallback: 'blocks',
        type: 'mcp',
        date: mcp.mappedAt,
        mcpStatus: mcp.status,
        mcpErrorMessage: mcp.errorMessage,
      })
    }

    rows.sort((a, b) => {
      if (a.date === undefined) return b.date === undefined ? 0 : 1
      if (b.date === undefined) return -1
      return safeDate(b.date).getTime() - safeDate(a.date).getTime()
    })

    return rows
  }, [accountsData, mcpsData])

  return (
    <HomeCollapsible title="Connections" className={className}>
      {connections.length > 0 ? (
        <div className="mt-2 divide-y divide-border/50">
          {connections.map((conn) => (
            <IntegrationRow
              key={conn.id}
              iconSlug={conn.iconSlug}
              iconFallback={conn.iconFallback}
              name={conn.name}
              nameBadge={<McpStatusPill status={conn.mcpStatus} errorMessage={conn.mcpErrorMessage} />}
              subtitle={
                <>
                  <span className="shrink-0">{conn.type === 'oauth' ? 'API' : 'MCP'}</span>
                  {conn.subtitle && (
                    <>
                      <span className="shrink-0">·</span>
                      <span className="truncate">{conn.subtitle}</span>
                    </>
                  )}
                  {conn.date !== undefined && (
                    <>
                      <span className="shrink-0">·</span>
                      <span className="whitespace-nowrap shrink-0">
                        {formatDistanceToNow(safeDate(conn.date), { addSuffix: true })}
                      </span>
                    </>
                  )}
                </>
              }
              onActivate={conn.foreign ? undefined : () => {
                void navigate({
                  to: '/agents/$slug/connections',
                  params: { slug: agentSlug },
                  search: { detail: conn.id, source: 'home' },
                })
              }}
              ariaLabel={conn.foreign ? undefined : `Open ${conn.name} connection details`}
              right={
                conn.foreign ? (
                  <span className="text-xs text-muted-foreground">Shared</span>
                ) : <>
                  {activityStats?.connectionById[conn.id] !== undefined ? (
                    <ActivitySparkChart
                      label={`${conn.name} activity`}
                      data={activityStats.connectionById[conn.id]}
                    />
                  ) : activityPending ? (
                    <ActivitySparkChartSkeleton />
                  ) : null}
                  <span
                    aria-hidden="true"
                    className="flex justify-center overflow-hidden w-0 opacity-0 transition-all duration-200 ease-out group-hover:w-4 group-hover:opacity-100 group-focus-visible:w-4 group-focus-visible:opacity-100"
                  >
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </span>
                </>
              }
            />
          ))}
        </div>
      ) : (
        <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
          <p className="text-xs font-medium text-foreground">No connections yet</p>
          <p className="text-xs mt-1">
            Connect APIs or MCP servers to give your agent access to external services like Gmail or Slack.
          </p>
        </div>
      )}
      <div className="flex items-center justify-between mt-3 px-4 pb-1">
        {connections.length === 0 && <FeaturedServicesStack />}
        <div className="ml-auto">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigate({ to: '/agents/$slug/connections', params: { slug: agentSlug } })
            }}
            data-testid="home-connections-open-page"
          >
            {connections.length > 0 ? <Settings2 /> : <Plus />}
            {connections.length > 0 ? 'Manage Connections' : 'Add Connection'}
          </Button>
        </div>
      </div>
    </HomeCollapsible>
  )
}
