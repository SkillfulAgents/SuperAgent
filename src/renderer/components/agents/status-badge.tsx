import { ExternalLink, Check } from 'lucide-react'
import type { ApiItemStatus } from '@shared/lib/types/api'

interface StatusBadgeProps {
  status: ApiItemStatus
}

export function StatusBadge({ status }: StatusBadgeProps) {
  switch (status.type) {
    case 'up_to_date':
      return (
        <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">
          Up to date
        </span>
      )
    case 'update_available':
      return (
        <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-700 dark:text-yellow-400">
          Update available{status.latestVersion ? ` (v${status.latestVersion})` : ''}
        </span>
      )
    case 'locally_modified':
      return status.openPrUrl ? (
        <a
          href={status.openPrUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs px-1.5 py-0 rounded-full bg-purple-500/10 text-purple-700 dark:text-purple-400 hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          Submitted
        </a>
      ) : (
        <span className="text-[10px] px-1.5 py-0 rounded-full bg-blue-500/10 text-blue-700 dark:text-blue-400">
          Locally modified
        </span>
      )
    case 'local':
      return (
        <span className="text-[10px] px-1.5 py-0 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">
          Local
        </span>
      )
    default:
      return null
  }
}
