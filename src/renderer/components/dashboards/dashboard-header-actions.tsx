import { Dock, ExternalLink, Loader2, MessageSquarePlus, RefreshCw } from 'lucide-react'
import { useDashboardHeader } from '@renderer/context/dashboard-header-context'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'

export function DashboardHeaderActions({
  agentSlug,
  dashboardSlug,
}: {
  agentSlug: string
  dashboardSlug: string | null
}) {
  const dashboardHeader = useDashboardHeader(agentSlug, dashboardSlug)
  const actions = dashboardHeader?.actions
  if (!actions) return null

  const refreshLabel = actions.refreshState === 'refreshing'
    ? 'Refreshing dashboard'
    : actions.refreshState === 'loading'
      ? 'Loading dashboard'
      : 'Refresh dashboard'

  const comment = actions.comment
  const commenting = comment && comment.state !== 'idle'

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex items-center gap-0" data-testid="dashboard-header-actions">
        {comment && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={comment.onToggle}
                disabled={comment.disabled || comment.state === 'opening' || comment.state === 'sending'}
                aria-pressed={!!commenting}
                aria-label={commenting ? 'Exit comment mode' : 'Add comment'}
                className={cn(
                  'gap-1.5 px-2.5',
                  commenting && 'bg-sky-500/15 text-sky-600 hover:bg-sky-500/20 hover:text-sky-600 dark:text-sky-300 dark:hover:text-sky-300',
                )}
              >
                {comment.state === 'opening' || comment.state === 'sending'
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <MessageSquarePlus className="h-4 w-4" />}
                <span className="hidden md:inline">{commenting ? 'Commenting' : 'Comment'}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{commenting ? 'Exit comment mode (Esc)' : 'Comment on this dashboard: an agent makes the change'}</p>
            </TooltipContent>
          </Tooltip>
        )}
        {actions.onAddToDock && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={actions.onAddToDock}
                aria-label="Add dashboard to Dock"
              >
                <Dock className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent><p>Add to Dock</p></TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={actions.onOpenExternal}
              aria-label="Open dashboard in new window"
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent><p>Open in new window</p></TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={actions.onRefresh}
              disabled={actions.refreshState !== 'idle'}
              aria-label={refreshLabel}
            >
              {actions.refreshState !== 'idle'
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <RefreshCw className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent><p>{refreshLabel}</p></TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}
