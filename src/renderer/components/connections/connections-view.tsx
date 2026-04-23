import { ArrowLeft } from 'lucide-react'
import { useSelection } from '@renderer/context/selection-context'
import { Button } from '@renderer/components/ui/button'
import { ConnectionsTab, NewIntegrationButton } from '@renderer/components/agents/settings/connections-tab'
import { useRenderTracker } from '@renderer/lib/perf'

interface ConnectionsViewProps {
  agentSlug: string
}

export function ConnectionsView({ agentSlug }: ConnectionsViewProps) {
  useRenderTracker('ConnectionsView')
  const { selectConnections } = useSelection()

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-[720px] px-6 pt-10 pb-6 space-y-10">
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 mb-2 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => selectConnections(false)}
            data-testid="connections-back-button"
          >
            <ArrowLeft className="h-3.5 w-3.5 mr-1" />
            Back to Agent Home
          </Button>
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="text-xl font-medium">Agent Connections</h2>
            </div>
            <div className="shrink-0">
              <NewIntegrationButton />
            </div>
          </div>
        </div>
        <ConnectionsTab agentSlug={agentSlug} showNewButton={false} />
      </div>
    </div>
  )
}
