import { useMemo, useState } from 'react'
import { Loader2, Zap } from 'lucide-react'
import { Label } from '@renderer/components/ui/label'
import { PolicyDecisionToggle } from '@renderer/components/ui/policy-decision-toggle'
import { PolicySummaryPill } from '@renderer/components/ui/policy-summary-pill'
import { ToolPolicySummaryPill } from '@renderer/components/ui/tool-policy-summary-pill'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import {
  useConnectedAccounts,
  useTriggerCountsPerAccount,
} from '@renderer/hooks/use-connected-accounts'
import { useRemoteMcps } from '@renderer/hooks/use-remote-mcps'
import { IntegrationList } from '@renderer/components/connections/integration-row'
import { NewIntegrationButton } from '@renderer/components/connections/connections-list'
import { FeaturedServicesStack } from '@renderer/components/connections/featured-services-stack'
import { IntegrationRowActions } from '@renderer/components/connections/integration-row-actions'
import { ConnectionRow } from '@renderer/components/connections/connection-row'
import { ConnectionAgentsPill } from '@renderer/components/connections/connection-agents-pill'
import { ConnectionAgentsDialog } from '@renderer/components/connections/connection-agents-dialog'
import { ScopePolicyEditor } from '@renderer/components/settings/scope-policy-editor'
import { ToolPolicyEditor } from '@renderer/components/settings/tool-policy-editor'
import { buildUnifiedRows, type UnifiedRow } from '@renderer/components/connections/unified-rows'
import { useOAuthReconnect } from '@renderer/hooks/use-oauth-reconnect'

export function ConnectionsTab() {
  const { data: settings } = useUserSettings()
  const updateSettings = useUpdateUserSettings()
  const { data: accountsData, isLoading: isLoadingAccounts } = useConnectedAccounts()
  const { data: mcpsData, isLoading: isLoadingMcps } = useRemoteMcps()
  const { data: triggerCounts } = useTriggerCountsPerAccount()
  const oauthReconnect = useOAuthReconnect()

  const [policyEditorAccount, setPolicyEditorAccount] = useState<{ id: string; toolkit: string } | null>(null)
  const [policyEditorMcp, setPolicyEditorMcp] = useState<{ id: string; name: string; tools: Array<{ name: string; description?: string }> } | null>(null)
  const [agentsDialogRow, setAgentsDialogRow] = useState<UnifiedRow | null>(null)

  const apiPolicy = settings?.defaultApiPolicy ?? 'review'
  const mcpPolicy = settings?.defaultMcpPolicy ?? 'review'

  const rows = useMemo(() => {
    const allAccounts = Array.isArray(accountsData?.accounts) ? accountsData.accounts : []
    const allMcps = Array.isArray(mcpsData?.servers) ? mcpsData.servers : []
    return buildUnifiedRows({ allAccounts, allMcps })
  }, [accountsData, mcpsData])

  const isLoading = isLoadingAccounts || isLoadingMcps

  const renderRow = (row: UnifiedRow) => {
    const triggerCount = row.type === 'oauth' ? triggerCounts?.[row.id] ?? 0 : 0
    return (
      <ConnectionRow
        key={row.key}
        row={row}
        onReconnect={row.type === 'oauth' && row.accountStatus && row.accountStatus !== 'active' && row.toolkit
          ? () => oauthReconnect(row.id, row.toolkit!)
          : undefined}
        subtitleExtra={
          triggerCount > 0 ? (
            <span className="inline-flex items-center gap-0.5 shrink-0">
              <Zap className="h-3 w-3" />
              {triggerCount} trigger{triggerCount > 1 ? 's' : ''}
            </span>
          ) : undefined
        }
        right={
          <>
            {row.type === 'oauth' && row.toolkit && (
              <PolicySummaryPill
                accountId={row.id}
                onClick={() => setPolicyEditorAccount({ id: row.id, toolkit: row.toolkit! })}
              />
            )}
            {row.type === 'mcp' && (
              <ToolPolicySummaryPill
                mcpId={row.id}
                onClick={() => setPolicyEditorMcp({ id: row.id, name: row.name, tools: row.mcpTools ?? [] })}
              />
            )}
            <ConnectionAgentsPill
              type={row.type}
              id={row.id}
              onClick={() => setAgentsDialogRow(row)}
            />
            <IntegrationRowActions
              type={row.type}
              id={row.id}
              name={row.name}
              toolkit={row.toolkit}
              mcpTools={row.mcpTools}
              accountStatus={row.accountStatus}
            />
          </>
        }
      />
    )
  }

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">
        Manage API accounts and MCP servers that agents can use.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="flex items-start justify-between rounded-md border p-3 gap-3">
          <div className="min-w-0">
            <Label className="text-sm font-medium">Default API Request Policy</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Controls what happens when agents make API calls without a specific scope policy.
            </p>
          </div>
          <PolicyDecisionToggle
            value={apiPolicy}
            onChange={(value) => {
              if (value === 'default') return
              updateSettings.mutate({ defaultApiPolicy: value })
            }}
            size="md"
          />
        </div>

        <div className="flex items-start justify-between rounded-md border p-3 gap-3">
          <div className="min-w-0">
            <Label className="text-sm font-medium">Default MCP Tool Policy</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Controls what happens when agents use MCP tools without a specific tool policy.
            </p>
          </div>
          <PolicyDecisionToggle
            value={mcpPolicy}
            onChange={(value) => {
              if (value === 'default') return
              updateSettings.mutate({ defaultMcpPolicy: value })
            }}
            size="md"
          />
        </div>
      </div>

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

      {policyEditorAccount && (
        <ScopePolicyEditor
          accountId={policyEditorAccount.id}
          toolkit={policyEditorAccount.toolkit}
          open={!!policyEditorAccount}
          onOpenChange={(open) => {
            if (!open) setPolicyEditorAccount(null)
          }}
        />
      )}

      {policyEditorMcp && (
        <ToolPolicyEditor
          mcpId={policyEditorMcp.id}
          mcpName={policyEditorMcp.name}
          tools={policyEditorMcp.tools}
          open={!!policyEditorMcp}
          onOpenChange={(open) => {
            if (!open) setPolicyEditorMcp(null)
          }}
        />
      )}

      {agentsDialogRow && (
        <ConnectionAgentsDialog
          type={agentsDialogRow.type}
          id={agentsDialogRow.id}
          name={agentsDialogRow.name}
          open={!!agentsDialogRow}
          onOpenChange={(open) => {
            if (!open) setAgentsDialogRow(null)
          }}
        />
      )}
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
