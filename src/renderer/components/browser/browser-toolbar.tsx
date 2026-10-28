import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Lock, RotateCw } from 'lucide-react'
import type { BrowserNavigateAction } from '@shared/lib/browser-stream-protocol'
import { cn } from '@shared/lib/utils/cn'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'

interface BrowserToolbarProps {
  url: string
  canGoBack: boolean
  canGoForward: boolean
  connected: boolean
  isViewOnly: boolean
  loading: boolean
  needsAttention: boolean
  onNavigate: (action: BrowserNavigateAction) => void
}

interface HeaderActionProps {
  label: string
  onClick?: () => void
  disabled?: boolean
  className?: string
  children: ReactNode
}

/** An accessible toolbar button with a tooltip. */
function HeaderAction({ label, onClick, disabled, className, children }: HeaderActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className={cn(
            'p-0.5 rounded hover:bg-muted transition-colors disabled:pointer-events-none disabled:opacity-30',
            className,
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function BrowserToolbar({
  url,
  canGoBack,
  canGoForward,
  connected,
  isViewOnly,
  loading,
  needsAttention,
  onNavigate,
}: BrowserToolbarProps) {
  const canNavigate = connected && !isViewOnly
  const isHttps = url.startsWith('https://')
  return (
    <div className="flex shrink-0 items-center gap-2 px-3 py-2" data-testid="browser-tray-toolbar">
      <TooltipProvider delayDuration={300}>
        <div className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
          <HeaderAction label="Back" onClick={() => onNavigate('back')} disabled={!canNavigate || !canGoBack}>
            <ArrowLeft className="h-4 w-4" />
          </HeaderAction>
          <HeaderAction label="Forward" onClick={() => onNavigate('forward')} disabled={!canNavigate || !canGoForward}>
            <ArrowRight className="h-4 w-4" />
          </HeaderAction>
          <HeaderAction label="Reload" onClick={() => onNavigate('reload')} disabled={!canNavigate}>
            <RotateCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </HeaderAction>
        </div>
        {/* Read-only: the page is the agent's to steer; this only says where it is. */}
        <div
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-black/5 bg-muted/60 px-3 py-1 dark:border-white/5"
          title={url || undefined}
          data-testid="browser-tray-url"
        >
          {isHttps && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {url || (connected ? 'about:blank' : 'Connecting…')}
          </span>
          {needsAttention && <span className="shrink-0 text-xs text-blue-600 dark:text-blue-400">Input needed</span>}
        </div>
      </TooltipProvider>
    </div>
  )
}
