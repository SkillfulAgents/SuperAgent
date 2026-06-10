import { useState } from 'react'
import { useSelection } from '@renderer/context/selection-context'
import { ConnectionsList, NewIntegrationButton } from '@renderer/components/connections/connections-list'
import { PageTitle, SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { useRenderTracker } from '@renderer/lib/perf'

interface ConnectionsViewProps {
  agentSlug: string
  /** Open with a row's detail view already shown (deep link from the home card). */
  initialDetailRowKey?: string
}

export function ConnectionsView({ agentSlug, initialDetailRowKey }: ConnectionsViewProps) {
  useRenderTracker('ConnectionsView')
  const { setView } = useSelection()

  // Key of the row whose detail page is open; null shows the list. The row
  // itself is resolved inside ConnectionsList from the freshest query data so
  // renames/deletes on the detail page stay live.
  const [detailRowKey, setDetailRowKey] = useState<string | null>(initialDetailRowKey ?? null)

  return (
    <SettingsPageContainer fullWidth={!!detailRowKey}>
      {!detailRowKey && (
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
        detailRowKey={detailRowKey}
        onDetailRowKeyChange={setDetailRowKey}
      />
    </SettingsPageContainer>
  )
}
