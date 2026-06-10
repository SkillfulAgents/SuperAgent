import { useState } from 'react'
import { useSelection } from '@renderer/context/selection-context'
import { useAgent } from '@renderer/hooks/use-agents'
import { ConnectionsList, NewIntegrationButton } from '@renderer/components/connections/connections-list'
import { PageTitle, SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { useRenderTracker } from '@renderer/lib/perf'

interface ConnectionsViewProps {
  agentSlug: string
  /** Open with a row's detail view already shown (deep link from the home card). */
  initialDetailRowKey?: string
}

/** Which surface opened the detail view — decides where Back leads. */
interface DetailState {
  rowKey: string
  source: 'home' | 'list'
}

export function ConnectionsView({ agentSlug, initialDetailRowKey }: ConnectionsViewProps) {
  useRenderTracker('ConnectionsView')
  const { setView } = useSelection()
  const { data: agent } = useAgent(agentSlug)

  // The row whose detail page is open; null shows the list. The row itself is
  // resolved inside ConnectionsList from the freshest query data so
  // renames/deletes on the detail page stay live.
  const [detail, setDetail] = useState<DetailState | null>(
    initialDetailRowKey ? { rowKey: initialDetailRowKey, source: 'home' } : null,
  )

  const agentName = agent?.name ?? 'Agent'
  // Back returns to wherever the detail view was opened from: the agent home
  // for a home-card deep link, otherwise the connections list.
  const closeDetail = () => {
    if (detail?.source === 'home') {
      setView({ kind: 'home' })
    } else {
      setDetail(null)
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
          if (key) setDetail({ rowKey: key, source: 'list' })
          else closeDetail()
        }}
      />
    </SettingsPageContainer>
  )
}
