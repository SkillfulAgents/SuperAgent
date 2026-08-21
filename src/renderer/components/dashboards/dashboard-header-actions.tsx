import { Dock, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { useDashboardHeader } from '@renderer/context/dashboard-header-context'
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

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex items-center gap-0" data-testid="dashboard-header-actions">
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
