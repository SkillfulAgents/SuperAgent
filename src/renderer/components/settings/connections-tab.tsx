import { useMemo, useEffect, useCallback } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronRight, Loader2, Zap } from 'lucide-react'
import { PolicyDecisionToggle } from '@renderer/components/ui/policy-decision-toggle'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import {
  useConnectedAccounts,
  useTriggerCountsPerAccount,
} from '@renderer/hooks/use-connected-accounts'
import { useRemoteMcps } from '@renderer/hooks/use-remote-mcps'
import { IntegrationList } from '@renderer/components/connections/integration-row'
import { NewIntegrationButton } from '@renderer/components/connections/connections-list'
import { FeaturedServicesStack } from '@renderer/components/connections/featured-services-stack'
import { ConnectionRow } from '@renderer/components/connections/connection-row'
import { ConnectionAgentCount } from '@renderer/components/connections/connection-agent-count'
import { ConnectionDetailPage } from '@renderer/components/connections/connection-detail-page'
import { ConnectionLogsView } from '@renderer/components/connections/connection-logs-view'
import { buildUnifiedRows, type UnifiedRow } from '@renderer/components/connections/unified-rows'
import { useOAuthReconnect } from '@renderer/hooks/use-oauth-reconnect'
import { useConnectionActivityStats } from '@renderer/hooks/use-activity-stats'
import { ActivitySparkChart, ActivitySparkChartSkeleton } from '@renderer/components/activity/activity-spark-chart'

export function ConnectionsTab() {
  const { data: settings } = useUserSettings()
  const updateSettings = useUpdateUserSettings()
  const { data: accountsData, isLoading: isLoadingAccounts } = useConnectedAccounts()
  const { data: mcpsData, isLoading: isLoadingMcps } = useRemoteMcps()
  const { data: triggerCounts } = useTriggerCountsPerAccount()
  const { data: activityStats, isPending: activityPending } = useConnectionActivityStats()
  const {
    reconnect: oauthReconnect,
    pendingAccountId,
    canCancelPendingReconnect,
    cancelReconnect,
  } = useOAuthReconnect()

  // The open connection detail lives in the URL (`/settings/connections?detail=…`)
  // so it's deep-linkable + reload-durable + back/forward-able — parity with the
  // agent connections route, which is also URL-driven. (Was local useState.)
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { detail?: string; connectionView?: string }
  const selectedRowKey = typeof search.detail === 'string' ? search.detail : null
  const selectedView = search.connectionView === 'logs' ? 'logs' : 'details'
  const setDetail = useCallback(
    (key: string | null) => {
      void navigate({
        to: '/settings/$tab',
        params: { tab: 'connections' },
        search: (prev) => ({ ...prev, detail: key ?? undefined, connectionView: undefined }),
      })
    },
    [navigate],
  )
  const setDetailView = useCallback(
    (view: 'details' | 'logs') => {
      void navigate({
        to: '/settings/$tab',
        params: { tab: 'connections' },
        search: (prev) => ({ ...prev, connectionView: view === 'logs' ? 'logs' : undefined }),
      })
    },
    [navigate],
  )

  const apiPolicy = settings?.defaultApiPolicy ?? 'review'
  const mcpPolicy = settings?.defaultMcpPolicy ?? 'review'

  const rows = useMemo(() => {
    const allAccounts = Array.isArray(accountsData?.accounts) ? accountsData.accounts : []
    const allMcps = Array.isArray(mcpsData?.servers) ? mcpsData.servers : []
    return buildUnifiedRows({ allAccounts, allMcps }).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
  }, [accountsData, mcpsData])

  const isLoading = isLoadingAccounts || isLoadingMcps

  // Resolve the selected row from the latest rows list (so it stays in sync if
  // data refetches). If the row disappeared, clear the selection.
  const selectedRow = selectedRowKey ? rows.find((r) => r.key === selectedRowKey) ?? null : null
  // A stale `?detail=` (the row was deleted, or never existed) → drop it from
  // the URL so we fall back to the list instead of a blank detail.
  useEffect(() => {
    if (selectedRowKey && !selectedRow && !isLoading) setDetail(null)
  }, [selectedRowKey, selectedRow, isLoading, setDetail])

  if (selectedRow) {
    if (selectedView === 'logs') {
      return <ConnectionLogsView row={selectedRow} onBack={() => setDetailView('details')} />
    }
    return (
      <ConnectionDetailPage
        row={selectedRow}
        onBack={() => setDetail(null)}
        onViewLogs={() => setDetailView('logs')}
      />
    )
  }

  const renderRow = (row: UnifiedRow) => {
    const triggerCount = row.type === 'oauth' ? triggerCounts?.[row.id] ?? 0 : 0
    const openDetail = () => setDetail(row.key)
    return (
      <ConnectionRow
        key={row.key}
        row={row}
        onActivate={openDetail}
        ariaLabel={`Open ${row.name} connection details`}
        onReconnect={
          row.type === 'oauth' && row.accountStatus && row.accountStatus !== 'active' && row.toolkit
            ? () => oauthReconnect(row.id, row.toolkit!)
            : undefined
        }
        onCancelReconnect={
          pendingAccountId === row.id && canCancelPendingReconnect
            ? cancelReconnect
            : undefined
        }
        reconnecting={pendingAccountId === row.id}
        subtitleExtra={
          <>
            <ConnectionAgentCount type={row.type} id={row.id} />
            {triggerCount > 0 && (
              <>
                <span className="shrink-0">·</span>
                <span className="inline-flex items-center gap-0.5 shrink-0">
                  <Zap className="h-3 w-3" />
                  {triggerCount} trigger{triggerCount > 1 ? 's' : ''}
                </span>
              </>
            )}
          </>
        }
        right={
          <>
            {activityStats?.connectionById[row.key] !== undefined ? (
              <ActivitySparkChart
                label={`${row.name} activity`}
                data={activityStats.connectionById[row.key]}
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
    )
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-xs font-normal text-muted-foreground">Default Policies</h3>
        <div className="rounded-xl border bg-background divide-y divide-border/50 overflow-hidden">
          <div data-testid="default-policy-api" className="py-3 px-4 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">Default API Request Policy</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                Used for connections that don&apos;t have an explicit API request policy set.
              </div>
            </div>
            <div className="shrink-0">
              <PolicyDecisionToggle
                value={apiPolicy}
                onChange={(value) => {
                  if (value === 'default') return
                  updateSettings.mutate({ defaultApiPolicy: value })
                }}
                size="sm"
              />
            </div>
          </div>

          <div data-testid="default-policy-mcp" className="py-3 px-4 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">Default MCP Tool Policy</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                Used for connections that don&apos;t have an explicit MCP tool policy set.
              </div>
            </div>
            <div className="shrink-0">
              <PolicyDecisionToggle
                value={mcpPolicy}
                onChange={(value) => {
                  if (value === 'default') return
                  updateSettings.mutate({ defaultMcpPolicy: value })
                }}
                size="sm"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-normal text-muted-foreground">Connections</h3>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading connections...
          </div>
        ) : rows.length === 0 ? (
          <ConnectionsEmptyState />
        ) : (
          <IntegrationList>{rows.map(renderRow)}</IntegrationList>
        )}
      </div>
    </div>
  )
}

function ConnectionsEmptyState() {
  return (
    <div
      className="rounded-xl border border-dashed bg-background px-6 py-10 text-center"
      data-testid="connections-empty-state"
    >
      <FeaturedServicesStack size="md" className="justify-center mb-4" />
      <p className="text-sm font-medium">No connections yet</p>
      <p className="text-xs text-muted-foreground mt-1 mx-auto max-w-sm">
        Connect APIs and MCP servers — like Gmail, Slack, Notion, or GitHub — to give your agents access to external services.
      </p>
      <div className="mt-4 inline-flex">
        <NewIntegrationButton />
      </div>
    </div>
  )
}
