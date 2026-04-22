import { ConnectionsTab } from '@renderer/components/agents/settings/connections-tab'
import { useRenderTracker } from '@renderer/lib/perf'

interface ConnectionsViewProps {
  agentSlug: string
}

export function ConnectionsView({ agentSlug }: ConnectionsViewProps) {
  useRenderTracker('ConnectionsView')

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-[600px] p-6 space-y-6">
        <div>
          <h2 className="text-xl font-semibold">Integrations</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage APIs and MCP servers this agent can access.
          </p>
        </div>
        <ConnectionsTab agentSlug={agentSlug} />
      </div>
    </div>
  )
}
