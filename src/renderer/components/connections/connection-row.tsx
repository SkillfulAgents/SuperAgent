import type { ReactNode } from 'react'
import { IntegrationRow } from './integration-row'
import { McpStatusPill } from './mcp-status-pill'
import { AccountStatusBadge } from './account-status-badge'
import { formatCompactDistance, safeDate } from './utils'
import type { UnifiedRow } from './unified-rows'

interface ConnectionRowProps {
  row: UnifiedRow
  /** Right-side slot — pills, actions, switch, etc. */
  right: ReactNode
  /**
   * Optional trailing items appended after the timestamp (e.g. agent count,
   * trigger count). Items render their own leading `·` separators so that
   * async items can mount late without leaving a dangling dot.
   */
  subtitleExtra?: ReactNode
  /** When set, animates row position via the View Transitions API. */
  viewTransitionName?: string
  /** When provided, the row becomes clickable (and Enter/Space-activatable). */
  onActivate?: () => void
  /** Accessible label for the row when interactive. */
  ariaLabel?: string
  /** Called when the user clicks the status badge to reconnect. */
  onReconnect?: () => void
  /** Called when the user cancels an in-flight reconnect. */
  onCancelReconnect?: () => void
  /** Show spinner on the status badge while reconnecting. */
  reconnecting?: boolean
}

export function ConnectionRow({
  row,
  right,
  subtitleExtra,
  viewTransitionName,
  onActivate,
  ariaLabel,
  onReconnect,
  onCancelReconnect,
  reconnecting,
}: ConnectionRowProps) {
  return (
    <IntegrationRow
      viewTransitionName={viewTransitionName}
      iconSlug={row.iconSlug}
      iconFallback={row.iconFallback}
      name={row.name}
      onActivate={onActivate}
      ariaLabel={ariaLabel}
      nameBadge={
        <>
          <McpStatusPill status={row.mcpStatus} errorMessage={row.mcpErrorMessage} />
          <AccountStatusBadge
            status={row.accountStatus}
            onReconnect={onReconnect}
            onCancelReconnect={onCancelReconnect}
            loading={reconnecting}
          />
        </>
      }
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
          <span className="whitespace-nowrap shrink-0 tabular-nums">
            {formatCompactDistance(safeDate(row.date))}
          </span>
          {subtitleExtra}
        </>
      }
      right={right}
    />
  )
}
