import { useEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import { Switch } from '@renderer/components/ui/switch'
import { Button } from '@renderer/components/ui/button'
import { Loader2, Plus } from 'lucide-react'
import { IntegrationDirectoryDialog } from '@renderer/components/connections/integration-directory-dialog'
import { IntegrationList } from '@renderer/components/connections/integration-row'
import { IntegrationRowActions } from '@renderer/components/connections/integration-row-actions'
import { ConnectionRow } from '@renderer/components/connections/connection-row'
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
import { buildUnifiedRows, type UnifiedRow } from '@renderer/components/connections/unified-rows'
import { startViewTransition } from '@renderer/lib/view-transition'

interface ConnectionsListProps {
  agentSlug: string
}

export function ConnectionsList({ agentSlug }: ConnectionsListProps) {
  return (
    <div className="flex flex-col gap-4">
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

  const renderRow = (row: UnifiedRow) => {
    const pending = isRowPending(row)
    return (
      <ConnectionRow
        key={row.key}
        row={row}
        viewTransitionName={`integration-${row.key}`}
        right={
          <>
            <IntegrationRowActions
              type={row.type}
              id={row.id}
              name={row.name}
              toolkit={row.toolkit}
              mcpTools={row.mcpTools}
              agentSlug={agentSlug}
              hideRemoveFromAgent
            />
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
