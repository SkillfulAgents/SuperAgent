import type { ReactNode } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { IntegrationRow } from './integration-row'
import { McpStatusPill } from './mcp-status-pill'
import { AccountStatusBadge } from './account-status-badge'
import { safeDate } from './utils'
import type { UnifiedRow } from './unified-rows'

interface ConnectionRowProps {
  row: UnifiedRow
  /** Right-side slot — pills, actions, switch, etc. */
  right: ReactNode
  /** Optional trailing item appended after the timestamp (e.g. trigger count). */
  subtitleExtra?: ReactNode
  /** When set, animates row position via the View Transitions API. */
  viewTransitionName?: string
  /** Called when the user clicks the status badge to reconnect. */
  onReconnect?: () => void
  /** Show spinner on the status badge while reconnecting. */
  reconnecting?: boolean
}

export function ConnectionRow({ row, right, subtitleExtra, viewTransitionName, onReconnect, reconnecting }: ConnectionRowProps) {
  return (
    <IntegrationRow
      viewTransitionName={viewTransitionName}
      iconSlug={row.iconSlug}
      iconFallback={row.iconFallback}
      name={row.name}
      nameBadge={
        <>
          <McpStatusPill status={row.mcpStatus} errorMessage={row.mcpErrorMessage} />
          <AccountStatusBadge status={row.accountStatus} onReconnect={onReconnect} loading={reconnecting} />
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
          <span className="whitespace-nowrap shrink-0">
            {formatDistanceToNow(safeDate(row.date), { addSuffix: true })}
          </span>
          {subtitleExtra && (
            <>
              <span className="shrink-0">·</span>
              {subtitleExtra}
            </>
          )}
        </>
      }
      right={right}
    />
  )
}
