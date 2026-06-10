import { useMemo } from 'react'
import { Button } from '@renderer/components/ui/button'
import { ChevronRight, Plus, Settings2 } from 'lucide-react'
import { useSelection } from '@renderer/context/selection-context'
import { IntegrationRow } from '@renderer/components/connections/integration-row'
import { McpStatusPill } from '@renderer/components/connections/mcp-status-pill'
import { useAgentConnectedAccounts } from '@renderer/hooks/use-connected-accounts'
import { useAgentRemoteMcps, type RemoteMcpServer } from '@renderer/hooks/use-remote-mcps'
import { HomeCollapsible } from './home-collapsible'
import { formatDistanceToNow } from 'date-fns'
import { safeDate } from '@renderer/components/connections/utils'
import { COMMON_MCP_SERVERS } from '@shared/lib/mcp/common-servers'
import { FeaturedServicesStack } from '@renderer/components/connections/featured-services-stack'

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
  date: string | number
  mcpStatus?: RemoteMcpServer['status']
  mcpErrorMessage?: string | null
}

export function HomeConnections({ agentSlug, className }: HomeConnectionsProps) {
  const { data: accountsData } = useAgentConnectedAccounts(agentSlug)
  const { data: mcpsData } = useAgentRemoteMcps(agentSlug)
  const { setView } = useSelection()

  const connections = useMemo<ConnectionRow[]>(() => {
    const rows: ConnectionRow[] = []

    const accounts = Array.isArray(accountsData?.accounts) ? accountsData.accounts : []
    for (const account of accounts) {
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
    for (const mcp of mcps) {
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

    rows.sort((a, b) => safeDate(b.date).getTime() - safeDate(a.date).getTime())

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
                  <span className="shrink-0">·</span>
                  <span className="whitespace-nowrap shrink-0">
                    {formatDistanceToNow(safeDate(conn.date), { addSuffix: true })}
                  </span>
                </>
              }
              onActivate={() => setView({ kind: 'connections', detailRowKey: conn.id })}
              ariaLabel={`Open ${conn.name} connection details`}
              right={
                <ChevronRight
                  className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  aria-hidden="true"
                />
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
            onClick={() => setView({ kind: 'connections' })}
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
