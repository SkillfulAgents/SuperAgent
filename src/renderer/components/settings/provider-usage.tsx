import { Progress } from '@renderer/components/ui/progress'
import { formatUsd } from '@renderer/lib/currency'
import { useProviderUsage, supportsUsage } from '@renderer/hooks/use-provider-usage'
import type { ConnectionInfo } from '@shared/lib/llm-provider/connection-schema'
import type { ProviderUsage as Snapshot } from '@shared/lib/llm-provider/usage-schema'

export function ProviderUsage({ connection, compact = false, descriptionId }: { connection: ConnectionInfo; compact?: boolean; descriptionId?: string }) {
  return supportsUsage(connection) ? <ConnectedUsage connection={connection} compact={compact} descriptionId={descriptionId} /> : null
}
function ConnectedUsage({ connection, compact, descriptionId }: { connection: ConnectionInfo; compact: boolean; descriptionId?: string }) {
  const { data, isError } = useProviderUsage(connection)
  if (isError || data?.status !== 'available') return null
  // Listbox options flatten their descendants. Give assistive tech a concise
  // description rather than relying on nested progressbar semantics.
  return descriptionId ? <span className="block w-full">
    <span id={descriptionId} className="sr-only">{data.limits.map(limit => limit.kind === 'window'
      ? `${limit.label}: ${Math.round(limit.usedPercent)}% used${limit.resetsAt ? `, resets ${new Date(limit.resetsAt).toLocaleString()}` : ''}`
      : `${limit.label}: ${formatBalance(limit)} remaining`).join('; ')}</span>
    <span aria-hidden="true"><UsageBars usage={data} compact={compact} /></span>
  </span> : <UsageBars usage={data} compact={compact} />
}

/** The fill always describes the percentage consumed, in the effort slider's blue at every level. */
export function UsageBars({ usage, compact = false }: { usage?: Snapshot; compact?: boolean }) {
  if (usage?.status !== 'available' || !usage.limits.length) return null
  return (
    <span className={`block space-y-2 ${compact ? 'mt-2.5 text-[10px]' : 'mt-3 max-w-lg text-xs'}`}>
      {usage.limits.map(limit => limit.kind === 'balance' ? (
        <span key={limit.id} className="flex items-center justify-between gap-3 text-muted-foreground">
          <span>{limit.label}</span>
          <span className="tabular-nums whitespace-nowrap text-foreground">
            {formatBalance(limit)}
          </span>
        </span>
      ) : (
        <span key={limit.id} className={compact ? 'grid grid-cols-[minmax(0,1fr)_64px_minmax(5ch,max-content)] items-center gap-2' : 'block space-y-1.5'}
          title={limit.resetsAt ? `Resets ${new Date(limit.resetsAt).toLocaleString()}` : undefined}>
          <span className="flex justify-between gap-3 text-muted-foreground">
            <span className="truncate">{limit.label}</span>
            {!compact && <span className="tabular-nums whitespace-nowrap">{Math.round(limit.usedPercent)}% used</span>}
          </span>
          <Progress percent={limit.usedPercent} role="progressbar" aria-label={`${limit.label} usage`} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={Math.min(100, limit.usedPercent)} aria-valuetext={`${Math.round(limit.usedPercent)}% used${limit.resetsAt ? `, resets ${new Date(limit.resetsAt).toLocaleString()}` : ''}`}
            // Same blue fill and track as the effort slider.
            fillClassName="bg-[#0099FF]" className={`bg-[#E1F6FF] dark:bg-[#15384F] ${compact ? 'h-1' : 'h-1.5'}`} />
          {compact ? <span className="text-right tabular-nums text-muted-foreground">{Math.round(limit.usedPercent)}%</span> : limit.resetsAt && <span className="block text-[11px] text-muted-foreground">Resets {new Date(limit.resetsAt).toLocaleString()}</span>}
        </span>
      ))}
    </span>
  )
}

function formatBalance(limit: Extract<NonNullable<Snapshot>['limits'][number], { kind: 'balance' }>) {
  return limit.unit === 'USD' ? formatUsd(limit.remaining) : `${limit.remaining.toLocaleString(undefined, { maximumFractionDigits: 2 })} credits`
}
