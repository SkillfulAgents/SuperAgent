import { ExternalLink } from 'lucide-react'

interface StatusBadgeProps {
  status: {
    type: 'local' | 'up_to_date' | 'update_available' | 'locally_modified'
    skillsetId?: string
    skillsetName?: string
    latestVersion?: string
    openPrUrl?: string
  }
}

export function StatusBadge({ status }: StatusBadgeProps) {
  switch (status.type) {
    case 'up_to_date':
      return (
        <span className="text-[10px] px-1.5 py-0 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">
          Up to date
        </span>
      )
    case 'update_available':
      return (
        <span className="text-[10px] px-1.5 py-0 rounded-full bg-yellow-500/10 text-yellow-700 dark:text-yellow-400">
          Update available
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
          PR opened
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
