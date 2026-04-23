import { useEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import { Switch } from '@renderer/components/ui/switch'
import { Button } from '@renderer/components/ui/button'
import { Loader2, Plus } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { IntegrationDirectoryDialog } from '@renderer/components/connections/integration-directory-dialog'
import { IntegrationList, IntegrationRow } from '@renderer/components/connections/integration-row'
import { IntegrationRowActions } from '@renderer/components/connections/integration-row-actions'
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
import { safeDate } from '@renderer/components/connections/utils'

interface ConnectionsTabProps {
  agentSlug: string
  /** Render the "New integration" action row above the list. Defaults to true. */
  showNewButton?: boolean
}

export function ConnectionsTab({ agentSlug, showNewButton = true }: ConnectionsTabProps) {
  return (
    <div className="flex flex-col gap-4">
      {showNewButton && (
        <div className="flex items-center justify-end gap-2">
          <NewIntegrationButton />
        </div>
      )}
      <AllConnectionsList agentSlug={agentSlug} />
    </div>
  )
}

export function NewIntegrationButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="connections-add-button"
      >
        <Plus className="h-4 w-4 mr-1.5" />
        New connection
      </Button>
      <IntegrationDirectoryDialog
        open={open}
        onOpenChange={setOpen}
        initialTab="apis"
      />
    </>
  )
}

interface UnifiedRow {
  key: string
  id: string
  name: string
  subtitle?: string
  iconSlug?: string
  iconFallback: 'oauth' | 'mcp' | 'blocks'
  type: 'oauth' | 'mcp'
  date: string | number
  granted: boolean
  toolkit?: string
  mcpTools?: Array<{ name: string; description?: string }>
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

  // Optimistic overrides keyed by row.key. Keeps the row visually in its new
  // section while the mutation is in-flight so the View Transition can animate
  // the move. Entries are cleared once the server-side truth matches.
  const [grantOverrides, setGrantOverrides] = useState<Record<string, boolean>>({})

  const { grantedRows, notGrantedRows } = useMemo<{
    grantedRows: UnifiedRow[]
    notGrantedRows: UnifiedRow[]
  }>(() => {
    const out: UnifiedRow[] = []

    const agentAccountIds = new Set((agentAccountsData?.accounts ?? []).map((a) => a.id))
    for (const account of allAccountsData?.accounts ?? []) {
      const key = `account-${account.id}`
      const serverGranted = agentAccountIds.has(account.id)
      out.push({
        key,
        id: account.id,
        name: account.displayName,
        subtitle: account.provider?.displayName ?? account.toolkitSlug,
        iconSlug: account.toolkitSlug,
        iconFallback: 'oauth',
        type: 'oauth',
        date: account.createdAt,
        granted: grantOverrides[key] ?? serverGranted,
        toolkit: account.toolkitSlug,
      })
    }

    const agentMcpIds = new Set((agentMcpsData?.mcps ?? []).map((m) => m.id))
    for (const mcp of allMcpsData?.servers ?? []) {
      const key = `mcp-${mcp.id}`
      const serverGranted = agentMcpIds.has(mcp.id)
      out.push({
        key,
        id: mcp.id,
        name: mcp.name,
        subtitle: mcp.url,
        iconSlug: COMMON_MCP_SERVERS.find((cs) => cs.url === mcp.url)?.slug,
        iconFallback: 'blocks',
        type: 'mcp',
        date: mcp.createdAt,
        granted: grantOverrides[key] ?? serverGranted,
        mcpTools: mcp.tools,
      })
    }

    const byDateDesc = (a: UnifiedRow, b: UnifiedRow) =>
      safeDate(b.date).getTime() - safeDate(a.date).getTime()

    return {
      grantedRows: out.filter((r) => r.granted).sort(byDateDesc),
      notGrantedRows: out.filter((r) => !r.granted).sort(byDateDesc),
    }
  }, [allAccountsData, agentAccountsData, allMcpsData, agentMcpsData, grantOverrides])

  // Drop overrides that the server has now caught up to.
  useEffect(() => {
    if (Object.keys(grantOverrides).length === 0) return
    const agentAccountIds = new Set((agentAccountsData?.accounts ?? []).map((a) => a.id))
    const agentMcpIds = new Set((agentMcpsData?.mcps ?? []).map((m) => m.id))
    setGrantOverrides((prev) => {
      let changed = false
      const next = { ...prev }
      for (const [k, v] of Object.entries(prev)) {
        const [kind, id] = k.split(/-(.+)/)
        const serverGranted =
          kind === 'account' ? agentAccountIds.has(id) : agentMcpIds.has(id)
        if (serverGranted === v) {
          delete next[k]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [agentAccountsData, agentMcpsData, grantOverrides])

  const isLoading =
    isLoadingAllAccounts || isLoadingAgentAccounts || isLoadingAllMcps || isLoadingAgentMcps

  const handleToggle = async (row: UnifiedRow, next: boolean) => {
    // Optimistic flip — wrapped in View Transitions so the row animates to its
    // new section.
    const apply = () => {
      flushSync(() => {
        setGrantOverrides((prev) => ({ ...prev, [row.key]: next }))
      })
    }
    const docWithVT = document as Document & { startViewTransition?: (cb: () => void) => unknown }
    if (typeof docWithVT.startViewTransition === 'function') {
      docWithVT.startViewTransition(apply)
    } else {
      apply()
    }

    try {
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
    } catch {
      // Revert the optimistic override so the row snaps back.
      setGrantOverrides((prev) => {
        const n = { ...prev }
        delete n[row.key]
        return n
      })
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
        viewTransitionName={`integration-${row.key}`}
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
            <span className="shrink-0">·</span>
            <span className="whitespace-nowrap shrink-0">
              {formatDistanceToNow(safeDate(row.date), { addSuffix: true })}
            </span>
          </>
        }
        right={
          <>
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            <IntegrationRowActions
              type={row.type}
              id={row.id}
              name={row.name}
              toolkit={row.toolkit}
              mcpTools={row.mcpTools}
            />
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
    <div className="space-y-6 max-w-[720px]">
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading connections...
        </div>
      ) : hasAny ? (
        <>
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground px-1">
              Access granted
            </p>
            {grantedRows.length > 0 ? (
              <IntegrationList>{grantedRows.map(renderRow)}</IntegrationList>
            ) : (
              <div className="rounded-xl border border-dashed bg-background px-4 py-6 text-center">
                <p className="text-xs text-muted-foreground">
                  This agent can&apos;t access any connections yet. Toggle one on below.
                </p>
              </div>
            )}
          </div>
          {notGrantedRows.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground px-1">
                Access not granted
              </p>
              <IntegrationList>{notGrantedRows.map(renderRow)}</IntegrationList>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No connections yet. Add one to get started.
        </p>
      )}
    </div>
  )
}
