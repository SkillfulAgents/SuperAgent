import { AlertTriangle, RefreshCw, Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils/cn'

type UnhealthyStatus = 'expired' | 'revoked'

const STATUS_COPY: Record<UnhealthyStatus, { label: string; headline: string; className: string; hoverClassName: string }> = {
  expired: {
    label: 'Expired',
    headline: 'Token expired — click to re-authenticate',
    className: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
    hoverClassName: 'hover:bg-amber-500/20 cursor-pointer',
  },
  revoked: {
    label: 'Revoked',
    headline: 'Connection revoked — click to re-authenticate',
    className: 'bg-destructive/10 text-destructive',
    hoverClassName: 'hover:bg-destructive/20 cursor-pointer',
  },
}

interface AccountStatusBadgeProps {
  status?: 'active' | 'expired' | 'revoked' | null
  onReconnect?: () => void
  loading?: boolean
}

export function AccountStatusBadge({ status, onReconnect, loading }: AccountStatusBadgeProps) {
  if (!status || status === 'active') return null
  const { label, headline, className, hoverClassName } = STATUS_COPY[status]

  if (loading) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 shrink-0 rounded-full px-1.5 py-0 text-2xs',
          className,
        )}
      >
        <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden="true" />
        Reconnecting…
      </span>
    )
  }

  const pill = (
    <span
      className={cn(
        'group/badge inline-flex items-center gap-1 shrink-0 rounded-full px-1.5 py-0 text-2xs transition-colors',
        className,
        onReconnect && hoverClassName,
      )}
      role={onReconnect ? 'button' : undefined}
      tabIndex={onReconnect ? 0 : undefined}
      onClick={onReconnect ? (e) => { e.stopPropagation(); onReconnect() } : undefined}
      onKeyDown={onReconnect ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onReconnect() } } : undefined}
    >
      <AlertTriangle className="h-2.5 w-2.5 group-hover/badge:hidden" aria-hidden="true" />
      <RefreshCw className="h-2.5 w-2.5 hidden group-hover/badge:block" aria-hidden="true" />
      <span className="group-hover/badge:hidden">{label}</span>
      <span className="hidden group-hover/badge:inline">Reconnect</span>
    </span>
  )

  if (!onReconnect) {
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>{pill}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-xs">
            {headline}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return pill
}
