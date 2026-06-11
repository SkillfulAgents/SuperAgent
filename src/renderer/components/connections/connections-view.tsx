import { useSelection } from '@renderer/context/selection-context'
import { useAgent } from '@renderer/hooks/use-agents'
import { ConnectionsList, NewIntegrationButton } from '@renderer/components/connections/connections-list'
import { PageTitle, SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { useRenderTracker } from '@renderer/lib/perf'

interface ConnectionsViewProps {
  agentSlug: string
}

export function ConnectionsView({ agentSlug }: ConnectionsViewProps) {
  useRenderTracker('ConnectionsView')
  const { view, setView } = useSelection()
  const { data: agent } = useAgent(agentSlug)

  // The open detail view lives on the selection view (not local state) so the
  // app-header breadcrumbs can mirror it. The row itself is resolved inside
  // ConnectionsList from the freshest query data so renames/deletes stay live.
  const detail = view.kind === 'connections' ? view.detail ?? null : null

  const agentName = agent?.name ?? 'Agent'
  // Back returns to wherever the detail view was opened from: the agent home
  // for a home-card deep link, otherwise the connections list.
  const closeDetail = () => {
    if (detail?.source === 'home') {
      setView({ kind: 'home' })
    } else {
      setView({ kind: 'connections' })
    }
  }

  return (
    <SettingsPageContainer fullWidth={!!detail}>
      {!detail && (
        <PageTitle
          title="Agent Connections"
          back={{
            onClick: () => setView({ kind: 'home' }),
            testId: 'connections-back-button',
          }}
          actions={<NewIntegrationButton />}
        />
      )}
      <ConnectionsList
        agentSlug={agentSlug}
        detailRowKey={detail?.rowKey ?? null}
        detailBackLabel={detail?.source === 'home' ? agentName : `${agentName} Connections`}
        onDetailRowKeyChange={(key) => {
          if (key) setView({ kind: 'connections', detail: { rowKey: key, source: 'list' } })
          else closeDetail()
        }}
      />
    </SettingsPageContainer>
  )
}
