import { useNavigate, useRouter } from '@tanstack/react-router'
import { useAgent } from '@renderer/hooks/use-agents'
import { ConnectionsList, NewIntegrationButton } from '@renderer/components/connections/connections-list'
import { PageTitle, SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { useRenderTracker } from '@renderer/lib/perf'

interface ConnectionsViewProps {
  agentSlug: string
  /** Open detail overlay, decoded from the route's `?detail&source&from` search. */
  detail: { rowKey: string; source: 'home' | 'list'; view?: 'logs'; from?: string } | null
}

export function ConnectionsView({ agentSlug, detail }: ConnectionsViewProps) {
  useRenderTracker('ConnectionsView')
  const navigate = useNavigate()
  const router = useRouter()
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
  const setDetailView = (view: 'details' | 'logs') => {
    if (!detail) return
    void navigate({
      to: '/agents/$slug/connections',
      params: { slug: agentSlug },
      search: {
        detail: detail.rowKey,
        source: detail.source,
        connectionView: view === 'logs' ? 'logs' : undefined,
        from: detail.from,
      },
    })
  }
  // Back returns to wherever the detail view was opened from: the `from` page
  // (e.g. a review card), the agent home for a home-card deep link, otherwise the
  // connections list.
  const closeDetail = () => {
    if (detail?.from) router.history.push(detail.from)
    else if (detail?.source === 'home') goAgentHome()
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
        detailView={detail?.view ?? 'details'}
        detailBackLabel={detail?.from ? 'Back' : detail?.source === 'home' ? agentName : `${agentName} Connections`}
        onDetailViewChange={setDetailView}
        onDetailRowKeyChange={(key) => {
          if (key) openDetail(key)
          else closeDetail()
        }}
      />
    </SettingsPageContainer>
  )
}
