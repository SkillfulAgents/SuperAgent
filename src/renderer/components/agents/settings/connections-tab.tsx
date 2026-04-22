import { useMemo, useState } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@renderer/components/ui/tabs'
import { Switch } from '@renderer/components/ui/switch'
import { Button } from '@renderer/components/ui/button'
import { Loader2, Plus } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { IntegrationDirectoryDialog, type DirectoryTab } from '@renderer/components/connections/integration-directory-dialog'
import { IntegrationList, IntegrationRow } from '@renderer/components/connections/integration-row'
import {
  useConnectedAccounts,
  useAgentConnectedAccounts,
  useAssignAccountsToAgent,
  useRemoveAgentConnectedAccount,
} from '@renderer/hooks/use-connected-accounts'
import {
  useRemoteMcps,
  useAgentRemoteMcps,
  useAssignMcpToAgent,
  useRemoveMcpFromAgent,
} from '@renderer/hooks/use-remote-mcps'
import { COMMON_MCP_SERVERS } from '@shared/lib/mcp/common-servers'
import { ConnectedAccountsTab } from './connected-accounts-tab'
import { RemoteMcpsTab } from './remote-mcps-tab'

export type ConnectionsSubtab = 'all' | 'accounts' | 'mcps'

interface ConnectionsTabProps {
  agentSlug: string
  onClose?: () => void
  initialSubtab?: ConnectionsSubtab
}

export function ConnectionsTab({ agentSlug, onClose, initialSubtab = 'all' }: ConnectionsTabProps) {
  const [subtab, setSubtab] = useState<ConnectionsSubtab>(initialSubtab)
  const [directoryOpen, setDirectoryOpen] = useState(false)

  const directoryInitialTab: DirectoryTab = subtab === 'mcps' ? 'mcps' : 'apis'

  return (
    <Tabs value={subtab} onValueChange={(v) => setSubtab(v as ConnectionsSubtab)} className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <TabsList>
          <TabsTrigger value="all" data-testid="connections-subtab-all">All</TabsTrigger>
          <TabsTrigger value="accounts" data-testid="connections-subtab-accounts">APIs</TabsTrigger>
          <TabsTrigger value="mcps" data-testid="connections-subtab-mcps">MCPs</TabsTrigger>
        </TabsList>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDirectoryOpen(true)}
          data-testid="connections-add-button"
        >
          <Plus className="h-4 w-4 mr-1.5" />
          New integration
        </Button>
        <IntegrationDirectoryDialog
          open={directoryOpen}
          onOpenChange={setDirectoryOpen}
          initialTab={directoryInitialTab}
        />
      </div>
      <TabsContent value="all" className="mt-0">
        <AllConnectionsList agentSlug={agentSlug} />
      </TabsContent>
      <TabsContent value="accounts" className="mt-0">
        <ConnectedAccountsTab agentSlug={agentSlug} />
      </TabsContent>
      <TabsContent value="mcps" className="mt-0">
        <RemoteMcpsTab agentSlug={agentSlug} onClose={onClose} />
      </TabsContent>
    </Tabs>
  )
}

interface UnifiedRow {
  key: string
  id: string
  name: string
  subtitle?: string
  iconSlug?: string
  iconFallback: 'oauth' | 'mcp'
  type: 'oauth' | 'mcp'
  date: string | number
  granted: boolean
}

function safeDate(value: string | number): Date {
  if (typeof value === 'number') return new Date(value)
  const num = Number(value)
  return Number.isFinite(num) ? new Date(num) : new Date(value)
}

interface AllConnectionsListProps {
  agentSlug: string
}

function AllConnectionsList({ agentSlug }: AllConnectionsListProps) {
  const { data: allAccountsData, isLoading: isLoadingAllAccounts } = useConnectedAccounts()
  const { data: agentAccountsData, isLoading: isLoadingAgentAccounts } = useAgentConnectedAccounts(agentSlug)
  const { data: allMcpsData, isLoading: isLoadingAllMcps } = useRemoteMcps()
  const { data: agentMcpsData, isLoading: isLoadingAgentMcps } = useAgentRemoteMcps(agentSlug)

  const assignAccounts = useAssignAccountsToAgent()
  const removeAccount = useRemoveAgentConnectedAccount()
  const assignMcp = useAssignMcpToAgent()
  const removeMcp = useRemoveMcpFromAgent()

  const { grantedRows, notGrantedRows } = useMemo<{
    grantedRows: UnifiedRow[]
    notGrantedRows: UnifiedRow[]
  }>(() => {
    const out: UnifiedRow[] = []

    const agentAccountIds = new Set((agentAccountsData?.accounts ?? []).map((a) => a.id))
    for (const account of allAccountsData?.accounts ?? []) {
      out.push({
        key: `account-${account.id}`,
        id: account.id,
        name: account.displayName,
        subtitle: account.provider?.displayName ?? account.toolkitSlug,
        iconSlug: account.toolkitSlug,
        iconFallback: 'oauth',
        type: 'oauth',
        date: account.createdAt,
        granted: agentAccountIds.has(account.id),
      })
    }

    const agentMcpIds = new Set((agentMcpsData?.mcps ?? []).map((m) => m.id))
    for (const mcp of allMcpsData?.servers ?? []) {
      out.push({
        key: `mcp-${mcp.id}`,
        id: mcp.id,
        name: mcp.name,
        subtitle: mcp.url,
        iconSlug: COMMON_MCP_SERVERS.find((cs) => cs.url === mcp.url)?.slug,
        iconFallback: 'mcp',
        type: 'mcp',
        date: mcp.createdAt,
        granted: agentMcpIds.has(mcp.id),
      })
    }

    const byDateDesc = (a: UnifiedRow, b: UnifiedRow) =>
      safeDate(b.date).getTime() - safeDate(a.date).getTime()

    return {
      grantedRows: out.filter((r) => r.granted).sort(byDateDesc),
      notGrantedRows: out.filter((r) => !r.granted).sort(byDateDesc),
    }
  }, [allAccountsData, agentAccountsData, allMcpsData, agentMcpsData])

  const isLoading =
    isLoadingAllAccounts || isLoadingAgentAccounts || isLoadingAllMcps || isLoadingAgentMcps

  const handleToggle = async (row: UnifiedRow, next: boolean) => {
    if (row.type === 'oauth') {
      if (next) {
        await assignAccounts.mutateAsync({ agentSlug, accountIds: [row.id] })
      } else {
        await removeAccount.mutateAsync({ agentSlug, accountId: row.id })
      }
    } else {
      if (next) {
        await assignMcp.mutateAsync({ agentSlug, mcpIds: [row.id] })
      } else {
        await removeMcp.mutateAsync({ agentSlug, mcpId: row.id })
      }
    }
  }

  const isRowPending = (row: UnifiedRow): boolean => {
    if (row.type === 'oauth') {
      if (assignAccounts.isPending && assignAccounts.variables?.accountIds.includes(row.id)) return true
      if (removeAccount.isPending && removeAccount.variables?.accountId === row.id) return true
      return false
    }
    if (assignMcp.isPending && assignMcp.variables?.mcpIds.includes(row.id)) return true
    if (removeMcp.isPending && removeMcp.variables?.mcpId === row.id) return true
    return false
  }

  const renderRow = (row: UnifiedRow) => {
    const pending = isRowPending(row)
    return (
      <IntegrationRow
        key={row.key}
        iconSlug={row.iconSlug}
        iconFallback={row.iconFallback}
        name={row.name}
        subtitle={
          <>
            <span className="shrink-0">{row.type === 'oauth' ? 'API' : 'MCP'}</span>
            {row.subtitle && (
              <>
                <span className="shrink-0">·</span>
                <span className="truncate">{row.subtitle}</span>
              </>
            )}
            <span className="mx-1 shrink-0">·</span>
            <span className="whitespace-nowrap shrink-0">
              {formatDistanceToNow(safeDate(row.date), { addSuffix: true })}
            </span>
          </>
        }
        onActivate={() => { if (!pending) void handleToggle(row, !row.granted) }}
        right={
          <>
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            <Switch
              checked={row.granted}
              disabled={pending}
              onClick={(e) => e.stopPropagation()}
              onCheckedChange={(next) => { void handleToggle(row, next) }}
              aria-label={`${row.granted ? 'Revoke' : 'Grant'} ${row.name} access for this agent`}
              data-testid={`connection-switch-${row.type}-${row.id}`}
            />
          </>
        }
      />
    )
  }

  const hasAny = grantedRows.length > 0 || notGrantedRows.length > 0

  return (
    <div className="space-y-6 max-w-[600px]">
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading connections...
        </div>
      ) : hasAny ? (
        <>
          {grantedRows.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-wide font-medium text-muted-foreground px-1">
                Access granted
              </p>
              <IntegrationList>{grantedRows.map(renderRow)}</IntegrationList>
            </div>
          )}
          {notGrantedRows.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-wide font-medium text-muted-foreground px-1">
                Access not granted
              </p>
              <IntegrationList>{notGrantedRows.map(renderRow)}</IntegrationList>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No integrations yet. Add one to get started.
        </p>
      )}
    </div>
  )
}
