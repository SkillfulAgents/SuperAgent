import { useEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import { Switch } from '@renderer/components/ui/switch'
import { Button } from '@renderer/components/ui/button'
import { ChevronRight, Loader2, Plus } from 'lucide-react'
import { IntegrationDirectoryDialog, type NewApiConnection, type NewMcpConnection } from '@renderer/components/connections/integration-directory-dialog'
import { IntegrationList } from '@renderer/components/connections/integration-row'
import { ConnectionDetailPage } from '@renderer/components/connections/connection-detail-page'
import { ConnectionRow } from '@renderer/components/connections/connection-row'
import { ScopePolicyEditor } from '@renderer/components/settings/scope-policy-editor'
import { ToolPolicyEditor } from '@renderer/components/settings/tool-policy-editor'
import { ConnectionSuccessHeader } from '@renderer/components/connections/connection-success-header'
import { getProvider } from '@shared/lib/account-providers/service-catalog'
import {
  useConnectedAccounts,
  useAgentConnectedAccounts,
  useAssignAccountsToAgent,
  useRemoveAgentConnectedAccount,
} from '@renderer/hooks/use-connected-accounts'
import { useOAuthReconnect } from '@renderer/hooks/use-oauth-reconnect'
import {
  useRemoteMcps,
  useAgentRemoteMcps,
  useAssignMcpToAgent,
  useRemoveMcpFromAgent,
} from '@renderer/hooks/use-remote-mcps'
import { buildUnifiedRows, type UnifiedRow } from '@renderer/components/connections/unified-rows'
import { startViewTransition } from '@renderer/lib/view-transition'

interface ConnectionsListProps {
  agentSlug: string
  /** Key of the row whose detail page is shown instead of the list. */
  detailRowKey: string | null
  /** Breadcrumb label for the detail page's Back button. */
  detailBackLabel?: string
  onDetailRowKeyChange: (key: string | null) => void
}

export function ConnectionsList({ agentSlug, detailRowKey, detailBackLabel, onDetailRowKeyChange }: ConnectionsListProps) {
  return (
    <div className="flex flex-col gap-4">
      <AllConnectionsList
        agentSlug={agentSlug}
        detailRowKey={detailRowKey}
        detailBackLabel={detailBackLabel}
        onDetailRowKeyChange={onDetailRowKeyChange}
      />
    </div>
  )
}

export function NewIntegrationButton() {
  const [open, setOpen] = useState(false)
  const [newApi, setNewApi] = useState<NewApiConnection | null>(null)
  const [newMcp, setNewMcp] = useState<NewMcpConnection | null>(null)

  const provider = newApi ? getProvider(newApi.toolkit) : null

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
        onApiConnected={setNewApi}
        onMcpConnected={setNewMcp}
      />
      {newApi && (
        <ScopePolicyEditor
          accountId={newApi.accountId}
          toolkit={newApi.toolkit}
          open
          onOpenChange={(isOpen) => { if (!isOpen) setNewApi(null) }}
          header={
            <ConnectionSuccessHeader
              toolkit={newApi.toolkit}
              displayName={provider?.displayName || newApi.toolkit}
            />
          }
        />
      )}
      {newMcp && (
        <ToolPolicyEditor
          mcpId={newMcp.mcpId}
          mcpName={newMcp.name}
          tools={newMcp.tools}
          open
          onOpenChange={(isOpen) => { if (!isOpen) setNewMcp(null) }}
        />
      )}
    </>
  )
}

interface AllConnectionsListProps {
  agentSlug: string
  detailRowKey: string | null
  detailBackLabel?: string
  onDetailRowKeyChange: (key: string | null) => void
}

function AllConnectionsList({ agentSlug, detailRowKey, detailBackLabel, onDetailRowKeyChange }: AllConnectionsListProps) {
  const { data: allAccountsData, isLoading: isLoadingAllAccounts } = useConnectedAccounts()
  const { data: agentAccountsData, isLoading: isLoadingAgentAccounts } = useAgentConnectedAccounts(agentSlug)
  const { data: allMcpsData, isLoading: isLoadingAllMcps } = useRemoteMcps()
  const { data: agentMcpsData, isLoading: isLoadingAgentMcps } = useAgentRemoteMcps(agentSlug)

  const assignAccounts = useAssignAccountsToAgent()
  const removeAccount = useRemoveAgentConnectedAccount()
  const assignMcp = useAssignMcpToAgent()
  const removeMcp = useRemoveMcpFromAgent()
  const { reconnect: oauthReconnect, pendingAccountId } = useOAuthReconnect()

  // Optimistic overrides keyed by row.key. Keeps the row visually in its new
  // section while the mutation is in-flight so the View Transition can animate
  // the move. Entries are cleared once the server-side truth matches.
  const [grantOverrides, setGrantOverrides] = useState<Record<string, boolean>>({})

  const { grantedRows, notGrantedRows } = useMemo<{
    grantedRows: UnifiedRow[]
    notGrantedRows: UnifiedRow[]
  }>(() => {
    const agentAccounts = Array.isArray(agentAccountsData?.accounts) ? agentAccountsData.accounts : []
    const allAccounts = Array.isArray(allAccountsData?.accounts) ? allAccountsData.accounts : []
    const agentMcps = Array.isArray(agentMcpsData?.mcps) ? agentMcpsData.mcps : []
    const allMcps = Array.isArray(allMcpsData?.servers) ? allMcpsData.servers : []

    const rows = buildUnifiedRows({
      allAccounts,
      allMcps,
      agentAccountIds: new Set(agentAccounts.map((a) => a.id)),
      agentMcpIds: new Set(agentMcps.map((m) => m.id)),
      grantOverrides,
    })

    return {
      grantedRows: rows.filter((r) => r.granted),
      notGrantedRows: rows.filter((r) => !r.granted),
    }
  }, [allAccountsData, agentAccountsData, allMcpsData, agentMcpsData, grantOverrides])

  // Drop overrides the server has now caught up to. Self-terminating: the
  // setter returns the same reference when no entries changed (changed=false),
  // so React bails out and the effect does not loop despite depending on
  // grantOverrides.
  useEffect(() => {
    if (Object.keys(grantOverrides).length === 0) return
    const agentAccountIds = new Set(
      (Array.isArray(agentAccountsData?.accounts) ? agentAccountsData.accounts : []).map((a) => a.id),
    )
    const agentMcpIds = new Set(
      (Array.isArray(agentMcpsData?.mcps) ? agentMcpsData.mcps : []).map((m) => m.id),
    )
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
    // Optimistic flip wrapped in View Transitions so the row animates to its
    // new section. flushSync forces the optimistic state into the DOM before
    // startViewTransition snapshots the "before" image — without it the
    // transition starts post-state and nothing animates.
    startViewTransition(() => {
      flushSync(() => {
        setGrantOverrides((prev) => ({ ...prev, [row.key]: next }))
      })
    })

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

  // Resolve the selected row from the freshest data so the detail page stays
  // live across renames; clear the selection once the row is truly gone.
  const selectedRow = detailRowKey
    ? [...grantedRows, ...notGrantedRows].find((r) => r.key === detailRowKey) ?? null
    : null
  if (detailRowKey && !selectedRow && !isLoading) {
    // Defer clearing to next tick to avoid setState during render.
    queueMicrotask(() => onDetailRowKeyChange(null))
  }

  if (selectedRow) {
    return (
      <ConnectionDetailPage
        row={selectedRow}
        backLabel={detailBackLabel}
        onBack={() => onDetailRowKeyChange(null)}
      />
    )
  }

  const renderRow = (row: UnifiedRow) => {
    const pending = isRowPending(row)
    return (
      <ConnectionRow
        key={row.key}
        row={row}
        viewTransitionName={`integration-${row.key}`}
        onActivate={() => onDetailRowKeyChange(row.key)}
        ariaLabel={`Open ${row.name} connection details`}
        onReconnect={row.type === 'oauth' && row.accountStatus && row.accountStatus !== 'active' && row.toolkit
          ? () => oauthReconnect(row.id, row.toolkit!)
          : undefined}
        reconnecting={pendingAccountId === row.id}
        right={
          <>
            {/* Slides in on row hover/focus; -ml-2 swallows the flex gap while hidden. */}
            <span
              aria-hidden="true"
              className="flex justify-center overflow-hidden w-0 -ml-2 opacity-0 transition-all duration-200 ease-out group-hover:w-4 group-hover:ml-0 group-hover:opacity-100 group-focus-visible:w-4 group-focus-visible:ml-0 group-focus-visible:opacity-100"
            >
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </span>
            {pending ? (
              <Loader2
                className="h-4 w-4 animate-spin text-muted-foreground"
                aria-label="Saving access change"
                data-testid={`connection-switch-${row.type}-${row.id}-pending`}
              />
            ) : (
              <Switch
                checked={row.granted}
                onClick={(e) => e.stopPropagation()}
                onCheckedChange={(next) => { void handleToggle(row, next) }}
                aria-label={`${row.granted ? 'Revoke' : 'Grant'} ${row.name} access for this agent`}
                data-testid={`connection-switch-${row.type}-${row.id}`}
              />
            )}
          </>
        }
      />
    )
  }

  const hasAny = grantedRows.length > 0 || notGrantedRows.length > 0

  return (
    <div className="space-y-6">
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
