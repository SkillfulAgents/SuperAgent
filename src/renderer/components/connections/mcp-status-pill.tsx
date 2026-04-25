import { AlertTriangle } from 'lucide-react'
import type { RemoteMcpServer } from '@renderer/hooks/use-remote-mcps'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils/cn'

type UnhealthyStatus = Exclude<RemoteMcpServer['status'], 'active'>

const STATUS_COPY: Record<UnhealthyStatus, { label: string; className: string }> = {
  error: {
    label: 'Error',
    className: 'bg-destructive/10 text-destructive',
  },
  auth_required: {
    label: 'Re-auth needed',
    className: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
}

interface McpStatusPillProps {
  status: UnhealthyStatus
  errorMessage?: string | null
}

/**
 * Shown on MCP rows when the server is not healthy. The pill has a tooltip
 * carrying the server-reported error message, so the user can tell a broken
 * MCP apart from a healthy one at a glance.
 */
export function McpStatusPill({ status, errorMessage }: McpStatusPillProps) {
  const { label, className } = STATUS_COPY[status]
  const Icon = AlertTriangle

  const pill = (
    <span
      className={cn(
        'inline-flex items-center gap-1 shrink-0 rounded-full px-1.5 py-0 text-2xs',
        className,
      )}
    >
      <Icon className="h-2.5 w-2.5" />
      {label}
    </span>
  )

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{pill}</TooltipTrigger>
        <TooltipContent>
          <div>Connection failed.</div>
          <div>Try re-authenticating</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
