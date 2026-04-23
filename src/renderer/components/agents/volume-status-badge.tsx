import { AlertTriangle } from 'lucide-react'

export function VolumeStatusBadge({ health }: { health: 'ok' | 'missing' }) {
  if (health === 'ok') {
    return (
      <span className="text-2xs px-1.5 py-0 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">
        OK
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
