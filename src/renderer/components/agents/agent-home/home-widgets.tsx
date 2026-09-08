import { useEffect, useRef } from 'react'
import { WidgetCard } from '@renderer/components/widgets/widget-card'
import { useAgentWidgets, useRefreshStaleWidgets } from '@renderer/hooks/use-widgets'
import { cn } from '@shared/lib/utils/cn'

/**
 * Widgets on the agent's home page. This is THE refresh trigger: opening
 * the page of the agent that owns them is what asks the host to bring stale
 * widgets up to date. App Home only shows what is cached — refreshing every
 * agent's widgets at launch would wake every container at once.
 */
export function HomeWidgets({ agentSlug, className }: { agentSlug: string; className?: string }) {
  const { data: widgets } = useAgentWidgets(agentSlug)
  const refreshStale = useRefreshStaleWidgets()
  const triggeredFor = useRef<string | null>(null)

  useEffect(() => {
    if (!widgets || widgets.length === 0 || triggeredFor.current === agentSlug) return
    // Once per mount per agent: a later SSE patch marking a widget stale must
    // not re-trigger (the after-run sweep covers that on the server).
    triggeredFor.current = agentSlug
    // Whether anything is stale is the server's call, not this list's. A
    // return visit is served from the query cache, and a cached listing that
    // still reads fresh would consume the mount trigger and leave an expired
    // widget unrefreshed. The endpoint re-reads the snapshots itself, wakes
    // the container only for widgets that need a run, and throttles per agent.
    refreshStale.mutate(agentSlug)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgets, agentSlug])

  if (!widgets || widgets.length === 0) return null

  return (
    <div className={cn('grid grid-cols-2 gap-3', className)} data-testid="home-widgets">
      {widgets.map((widget) => (
        <div
          key={widget.slug}
          className={widget.size === 'medium' ? 'col-span-2 aspect-[2/1]' : 'aspect-square'}
        >
          <WidgetCard widget={widget} agentSlug={agentSlug} variant="push" />
        </div>
      ))}
    </div>
  )
}
