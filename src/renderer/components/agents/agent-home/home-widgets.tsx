import { WidgetCard } from '@renderer/components/widgets/widget-card'
import { useAgentWidgets } from '@renderer/hooks/use-widgets'
import { cn } from '@shared/lib/utils/cn'

/**
 * The visible widget cards. Agent Home owns the refresh-on-visit trigger so
 * closing or remounting this panel cannot suppress or repeat a refresh.
 */
export function HomeWidgets({ agentSlug, className }: { agentSlug: string; className?: string }) {
  const { data: widgets } = useAgentWidgets(agentSlug)
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
