import { AlertTriangle, Loader2 } from 'lucide-react'
import type { VolumeAttention, VolumeSummaryWithHealth } from '@shared/lib/types/mount'

export function VolumeStatusBadge({ health, attention }: { health: VolumeSummaryWithHealth['health']; attention?: VolumeAttention }) {
  if (health === 'ok' && attention?.badge) {
    const tone = attention.badge.tone === 'error' ? 'bg-red-500/10 text-red-700 dark:text-red-400' : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
    return (
      <span className={`inline-flex items-center gap-1 text-2xs px-1.5 py-0 rounded-full ${tone}`} title={attention.detail}>
        <AlertTriangle className="h-2.5 w-2.5" />
        {attention.badge.label}
      </span>
    )
  }
  if (health === 'ok') {
    return (
      <span className="text-2xs px-1.5 py-0 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">
        OK
      </span>
    )
  }
  if (health === 'preparing') {
    return (
      <span className="inline-flex items-center gap-1 text-2xs px-1.5 py-0 rounded-full bg-muted text-muted-foreground">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        Preparing
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-2xs px-1.5 py-0 rounded-full bg-red-500/10 text-red-700 dark:text-red-400">
      <AlertTriangle className="h-2.5 w-2.5" />
      Missing
    </span>
  )
}
