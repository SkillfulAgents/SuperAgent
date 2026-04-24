import { AlertTriangle, Lock } from 'lucide-react'
import type { RemoteMcpServer } from '@renderer/hooks/use-remote-mcps'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils/cn'

const STATUS_COPY: Record<Exclude<RemoteMcpServer['status'], 'active'>, { label: string; className: string }> = {
  error: {
    label: 'Error',
    className: 'bg-destructive/10 text-destructive border-destructive/30',
  },
  auth_required: {
    label: 'Auth required',
    className: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30',
  },
}

interface McpStatusPillProps {
  status: Exclude<RemoteMcpServer['status'], 'active'>
  errorMessage?: string | null
}

/**
 * Shown on MCP rows when the server is not healthy. The pill has a tooltip
 * carrying the server-reported error message, so the user can tell a broken
 * MCP apart from a healthy one at a glance.
 */
export function McpStatusPill({ status, errorMessage }: McpStatusPillProps) {
  const { label, className } = STATUS_COPY[status]
  const Icon = status === 'error' ? AlertTriangle : Lock
  const tooltip = errorMessage?.trim() || label

  const pill = (
    <span
      className={cn(
        'inline-flex items-center gap-1 shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
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
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
