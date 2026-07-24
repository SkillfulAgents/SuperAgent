import { ChevronLeft } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { ConnectionAgentsList } from '@renderer/components/connections/connection-agents-list'
import { IntegrationRowActions } from '@renderer/components/connections/integration-row-actions'
import { ConnectionUsageCard } from '@renderer/components/connections/connection-usage-card'
import { ScopePolicySection } from '@renderer/components/settings/scope-policy-editor'
import { ToolPolicyEditorBody } from '@renderer/components/settings/tool-policy-editor'
import {
  useHideSettingsHeader,
  useFullWidthSettingsContent,
} from '@renderer/components/settings/settings-page'
import { formatCompactDistance, safeDate } from '@renderer/components/connections/utils'
import type { UnifiedRow } from '@renderer/components/connections/unified-rows'

interface ConnectionDetailPageProps {
  row: UnifiedRow
  onBack: () => void
  /**
   * Breadcrumb label naming where Back leads — e.g. "<Agent> Connections" on
   * the agent connections page, or the agent's name for a home-card deep link.
   */
  backLabel?: string
  onViewLogs: () => void
}

/**
 * Detail view for a single connection: two columns showing which agents have
 * access and the per-scope / per-tool permissions for the connection.
 */
export function ConnectionDetailPage({ row, onBack, onViewLogs, backLabel = 'Connections' }: ConnectionDetailPageProps) {
  // Hide the default SettingsPage header — the detail page owns its own — and
  // use the full inset width so the two columns can lay out like the agent home.
  useHideSettingsHeader(true)
  useFullWidthSettingsContent(true)
  return (
    <div className="space-y-4 w-full max-w-6xl mx-auto">
      {/* Back / breadcrumb */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="-ml-2 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          data-testid="connection-detail-back"
        >
          <ChevronLeft className="h-3.5 w-3.5 mr-1" />
          {backLabel}
        </Button>
      </div>

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-md bg-muted dark:bg-zinc-200 flex items-center justify-center shrink-0">
          <ServiceIcon
            slug={row.iconSlug}
            fallback={row.iconFallback}
            className="h-5 w-5 text-muted-foreground/60"
          />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-medium truncate">{row.name}</h2>
          <p className="text-xs text-muted-foreground truncate">
            {row.type === 'oauth' ? 'API' : 'MCP'}
            {row.subtitle ? ` · ${row.subtitle}` : ''}
            {row.date !== undefined && (
              <>
                {' · '}
                <span className="tabular-nums">{formatCompactDistance(safeDate(row.date))}</span>
              </>
            )}
          </p>
        </div>
        <div className="shrink-0">
          <IntegrationRowActions
            type={row.type}
            id={row.id}
            name={row.name}
            toolkit={row.toolkit}
            mcpTools={row.mcpTools}
            accountStatus={row.accountStatus}
          />
        </div>
      </div>

      {/* Two columns (like the agent home): the agents column is flexible and
          grows/shrinks with the window; the permissions column is a fixed width. */}
      <div className="grid gap-4 items-start grid-cols-1 xl:grid-cols-[1fr_32rem] pt-4">
        {/* Agents column */}
        <section className="min-w-0">
          <ConnectionAgentsList type={row.type} id={row.id} name={row.name} sectioned />
        </section>

        {/* Permissions column */}
        <div className="space-y-4 min-w-0">
          <ConnectionUsageCard row={row} onViewLogs={onViewLogs} />

          {row.type === 'oauth' && row.toolkit ? (
            <ScopePolicySection accountId={row.id} toolkit={row.toolkit} />
          ) : (
            <section className="space-y-2 min-w-0">
              <h3 className="text-xs font-normal text-muted-foreground">Permissions</h3>
              <div className="rounded-xl border bg-background py-2 overflow-hidden">
                {row.type === 'mcp' ? (
                  <div className="px-3">
                    <ToolPolicyEditorBody
                      mcpId={row.id}
                      tools={row.mcpTools ?? []}
                    />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No permissions configurable for this connection.
                  </p>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
