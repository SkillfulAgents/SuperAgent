import { useMemo } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Plus, Settings2 } from 'lucide-react'
import { useSelection } from '@renderer/context/selection-context'
import { IntegrationRow } from '@renderer/components/connections/integration-row'
import { IntegrationRowActions } from '@renderer/components/connections/integration-row-actions'
import { McpStatusPill } from '@renderer/components/connections/mcp-status-pill'
import { useAgentConnectedAccounts } from '@renderer/hooks/use-connected-accounts'
import { useAgentRemoteMcps, type RemoteMcpServer } from '@renderer/hooks/use-remote-mcps'
import { HomeCollapsible } from './home-collapsible'
import { formatDistanceToNow } from 'date-fns'
import { safeDate } from '@renderer/components/connections/utils'
import { COMMON_MCP_SERVERS } from '@shared/lib/mcp/common-servers'

interface HomeConnectionsProps {
  agentSlug: string
}

interface ConnectionRow {
  id: string
  rawId: string
  name: string
  subtitle?: string
  iconSlug?: string
  iconFallback: 'oauth' | 'mcp' | 'blocks'
  type: 'oauth' | 'mcp'
  date: string | number
  toolkit?: string
  mcpTools?: Array<{ name: string; description?: string }>
  mcpStatus?: RemoteMcpServer['status']
  mcpErrorMessage?: string | null
}

const FEATURED_SERVICE_SLUGS = ['atlassian', 'slack', 'notion', 'github', 'linear', 'figma', 'gmail']

export function HomeConnections({ agentSlug }: HomeConnectionsProps) {
  const { data: accountsData } = useAgentConnectedAccounts(agentSlug)
  const { data: mcpsData } = useAgentRemoteMcps(agentSlug)
  const { selectConnections } = useSelection()

  const connections = useMemo<ConnectionRow[]>(() => {
    const rows: ConnectionRow[] = []

    const accounts = Array.isArray(accountsData?.accounts) ? accountsData.accounts : []
    for (const account of accounts) {
      rows.push({
        id: `account-${account.id}`,
        rawId: account.id,
        name: account.provider?.displayName ?? account.toolkitSlug,
        subtitle: account.displayName,
        iconSlug: account.toolkitSlug,
        iconFallback: 'oauth',
        type: 'oauth',
        date: account.createdAt,
        toolkit: account.toolkitSlug,
      })
    }

    const mcps = Array.isArray(mcpsData?.mcps) ? mcpsData.mcps : []
    for (const mcp of mcps) {
      rows.push({
        id: `mcp-${mcp.id}`,
        rawId: mcp.id,
        name: mcp.name,
        subtitle: mcp.url,
        iconSlug: COMMON_MCP_SERVERS.find((cs) => cs.url === mcp.url)?.slug,
        iconFallback: 'blocks',
        type: 'mcp',
        date: mcp.mappedAt,
        mcpTools: mcp.tools,
        mcpStatus: mcp.status,
        mcpErrorMessage: mcp.errorMessage,
      })
    }

    rows.sort((a, b) => safeDate(b.date).getTime() - safeDate(a.date).getTime())

    return rows
  }, [accountsData, mcpsData])

  return (
    <HomeCollapsible title="Connections">
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
              right={
                <IntegrationRowActions
                  type={conn.type}
                  id={conn.rawId}
                  name={conn.name}
                  toolkit={conn.toolkit}
                  mcpTools={conn.mcpTools}
                  agentSlug={agentSlug}
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
        {connections.length === 0 && (
          <div className="flex items-center" aria-hidden="true">
            {FEATURED_SERVICE_SLUGS.map((slug, i) => (
              <div
                key={slug}
                className="h-8 w-8 rounded-lg border border-border bg-background flex items-center justify-center shadow-sm transition-transform duration-100 ease-out hover:scale-110 hover:z-10"
                style={{ marginLeft: i === 0 ? 0 : -8, zIndex: i }}
              >
                <img
                  src={`${import.meta.env.BASE_URL}service-icons/${slug}.svg`}
                  alt=""
                  className="h-4 w-4 object-contain"
                />
              </div>
            ))}
            <div
              className="h-8 w-8 rounded-lg border border-border bg-background flex items-center justify-center shadow-sm transition-transform duration-100 ease-out hover:scale-110 hover:z-10"
              style={{ marginLeft: -8, zIndex: FEATURED_SERVICE_SLUGS.length }}
            >
              <span className="text-2xs font-medium text-muted-foreground/70">70+</span>
            </div>
          </div>
        )}
        <div className="ml-auto">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => selectConnections(true)}
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
