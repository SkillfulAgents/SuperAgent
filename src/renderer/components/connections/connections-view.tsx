import { useNavigate } from '@tanstack/react-router'
import { useAgent } from '@renderer/hooks/use-agents'
import { ConnectionsList, NewIntegrationButton } from '@renderer/components/connections/connections-list'
import { PageTitle, SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { useRenderTracker } from '@renderer/lib/perf'

interface ConnectionsViewProps {
  agentSlug: string
  /** Open detail overlay, decoded from the route's `?detail&source` search. */
  detail: { rowKey: string; source: 'home' | 'list' } | null
}

export function ConnectionsView({ agentSlug, detail }: ConnectionsViewProps) {
  useRenderTracker('ConnectionsView')
  const navigate = useNavigate()
  const { data: agent } = useAgent(agentSlug)

  const agentName = agent?.name ?? 'Agent'

  // The open detail overlay travels in the URL search now (deep-linkable); the
  // row itself is resolved inside ConnectionsList from the freshest query data so
  // renames/deletes stay live. Each handler navigates via the URL; the header
  // crumb is route-driven (AgentHeader derives it from the URL).
  const goAgentHome = () => {
    void navigate({ to: '/agents/$slug', params: { slug: agentSlug } })
  }
  const openList = () => {
    void navigate({ to: '/agents/$slug/connections', params: { slug: agentSlug } })
  }
  const openDetail = (rowKey: string) => {
    void navigate({
      to: '/agents/$slug/connections',
      params: { slug: agentSlug },
      search: { detail: rowKey, source: 'list' },
    })
  }
  // Back returns to wherever the detail view was opened from: the agent home for
  // a home-card deep link, otherwise the connections list.
  const closeDetail = () => {
    if (detail?.source === 'home') goAgentHome()
    else openList()
  }

  return (
    <SettingsPageContainer fullWidth={!!detail}>
      {!detail && (
        <PageTitle
          title="Agent Connections"
          back={{
            onClick: goAgentHome,
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
          if (key) openDetail(key)
          else closeDetail()
        }}
      />
    </SettingsPageContainer>
  )
}
