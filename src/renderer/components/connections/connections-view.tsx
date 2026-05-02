import { useSelection } from '@renderer/context/selection-context'
import { ConnectionsList, NewIntegrationButton } from '@renderer/components/connections/connections-list'
import { PageTitle, SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { useRenderTracker } from '@renderer/lib/perf'

interface ConnectionsViewProps {
  agentSlug: string
}

export function ConnectionsView({ agentSlug }: ConnectionsViewProps) {
  useRenderTracker('ConnectionsView')
  const { selectConnections } = useSelection()

  return (
    <SettingsPageContainer>
      <PageTitle
        title="Agent Connections"
        back={{
          onClick: () => selectConnections(false),
          testId: 'connections-back-button',
        }}
        actions={<NewIntegrationButton />}
      />
      <ConnectionsList agentSlug={agentSlug} />
    </SettingsPageContainer>
  )
}
