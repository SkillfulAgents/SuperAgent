import { useProviderUsage, supportsUsage } from '@renderer/hooks/use-provider-usage'
import type { ConnectionInfo } from '@shared/lib/llm-provider/connection-schema'
import type { ProviderUsage as Snapshot } from '@shared/lib/llm-provider/usage-schema'

export function ProviderUsage({ connection, compact = false }: { connection: ConnectionInfo; compact?: boolean }) {
  return supportsUsage(connection) ? <ConnectedUsage connection={connection} compact={compact} /> : null
}
function ConnectedUsage({ connection, compact }: { connection: ConnectionInfo; compact: boolean }) {
  const { data, isError } = useProviderUsage(connection)
  return isError ? null : <UsageBars usage={data} compact={compact} />
}

/** The fill and warning thresholds always describe the percentage consumed. */
export function UsageBars({ usage, compact = false }: { usage?: Snapshot; compact?: boolean }) {
  if (usage?.status !== 'available' || !usage.limits.length) return null
  return (
    <span className={`block space-y-2 ${compact ? 'mt-1.5 text-[10px]' : 'mt-3 max-w-lg text-xs'}`}>
      {usage.limits.map(limit => limit.kind === 'balance' ? (
        <span key={limit.id} className="flex items-center justify-between gap-3 text-muted-foreground">
          <span>{limit.label}</span>
          <span className="tabular-nums whitespace-nowrap text-foreground">
            {limit.unit === 'USD' ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(limit.remaining) : `${limit.remaining.toLocaleString(undefined, { maximumFractionDigits: 2 })} credits`}
          </span>
        </span>
      ) : (
        <span key={limit.id} className={compact ? 'grid grid-cols-[minmax(0,1fr)_64px_3ch] items-center gap-2' : 'block space-y-1.5'}
          title={limit.resetsAt ? `Resets ${new Date(limit.resetsAt).toLocaleString()}` : undefined}>
          <span className="flex justify-between gap-3 text-muted-foreground">
            <span className="truncate">{limit.label}</span>
            {!compact && <span className="tabular-nums whitespace-nowrap">{Math.round(limit.usedPercent)}% used</span>}
          </span>
          <span role="progressbar" aria-label={`${limit.label} usage`} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={Math.min(100, limit.usedPercent)} aria-valuetext={`${Math.round(limit.usedPercent)}% used${limit.resetsAt ? `, resets ${new Date(limit.resetsAt).toLocaleString()}` : ''}`}
            className={`block overflow-hidden rounded-full bg-foreground/10 ${compact ? 'h-1' : 'h-1.5'}`}>
            <span className={`block h-full rounded-full ${limit.usedPercent > 95 ? 'bg-red-500' : limit.usedPercent > 80 ? 'bg-orange-500' : 'bg-primary'}`}
              style={{ width: `${Math.min(100, limit.usedPercent)}%` }} />
          </span>
          {compact ? <span className="text-right tabular-nums text-muted-foreground">{Math.round(limit.usedPercent)}%</span> : limit.resetsAt && <span className="block text-[11px] text-muted-foreground">Resets {new Date(limit.resetsAt).toLocaleString()}</span>}
        </span>
      ))}
    </span>
  )
}
