import { AlertTriangle } from 'lucide-react'
import type { RemoteMcpServer } from '@renderer/hooks/use-remote-mcps'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils/cn'

type UnhealthyStatus = Exclude<RemoteMcpServer['status'], 'active'>

const STATUS_COPY: Record<UnhealthyStatus, { label: string; headline: string; className: string }> = {
  error: {
    label: 'Error',
    headline: 'Connection failed',
    className: 'bg-destructive/10 text-destructive',
  },
  auth_required: {
    label: 'Re-auth needed',
    headline: 'Re-authenticate to restore access',
    className: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
}

interface McpStatusPillProps {
  /** Pill renders only when the server is unhealthy; pass the raw status and we gate. */
  status?: RemoteMcpServer['status'] | null
  errorMessage?: string | null
}

/**
 * Shown on MCP rows when the server is not healthy. The pill surfaces a
 * status label and a tooltip whose body branches on the failure mode and
 * appends the server-reported error message when present.
 */
export function McpStatusPill({ status, errorMessage }: McpStatusPillProps) {
  if (!status || status === 'active') return null
  const { label, headline, className } = STATUS_COPY[status]
  const trimmedError = errorMessage?.trim()

  const pill = (
    <span
      className={cn(
        'inline-flex items-center gap-1 shrink-0 rounded-full px-1.5 py-0 text-2xs',
        className,
      )}
    >
      <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
      {label}
    </span>
  )

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{pill}</TooltipTrigger>
        <TooltipContent>
          <div>{headline}</div>
          {trimmedError && (
            <div className="mt-1 text-muted-foreground/80">{trimmedError}</div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
