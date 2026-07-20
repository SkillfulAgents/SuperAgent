import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { useAgents } from '@renderer/hooks/use-agents'
import { Button } from '@renderer/components/ui/button'
import { PageTitle } from '@renderer/components/layout/settings-page'
import {
  useFullWidthSettingsContent,
  useHideSettingsHeader,
} from '@renderer/components/settings/settings-page'
import {
  REQUEST_LOG_PAGE_SIZE,
  RequestLogsTable,
} from '@renderer/components/api-logs/request-logs-table'
import type { UnifiedRow } from '@renderer/components/connections/unified-rows'
import type { RequestLogPage } from '@shared/lib/types/request-log'

interface ConnectionLogsViewProps {
  row: UnifiedRow
  onBack: () => void
}

const selectAgentNames = (agents: Array<{ slug: string; name: string }>) =>
  Object.fromEntries(agents.map((agent) => [agent.slug, agent.name]))

export function ConnectionLogsView({ row, onBack }: ConnectionLogsViewProps) {
  useHideSettingsHeader(true)
  useFullWidthSettingsContent(true)
  const [page, setPage] = useState(0)
  const { data: agentNames = {} } = useAgents({ select: selectAgentNames })
  const kind = row.type === 'oauth' ? 'account' : 'mcp'

  useEffect(() => setPage(0), [row.key])

  const { data, isLoading, refetch, isRefetching } = useQuery<RequestLogPage>({
    queryKey: ['connection-request-log', kind, row.id, page],
    queryFn: async () => {
      const response = await apiFetch(
        `/api/connection-logs/${kind}/${encodeURIComponent(row.id)}?offset=${page * REQUEST_LOG_PAGE_SIZE}&limit=${REQUEST_LOG_PAGE_SIZE}`,
      )
      if (!response.ok) throw new Error('Failed to fetch connection request logs')
      return response.json()
    },
  })

  return (
    <div className="space-y-6 w-full max-w-5xl mx-auto">
      <PageTitle
        title={
          <div>
            <h2 className="text-xl font-medium">Connection Logs</h2>
            <p className="mt-1 text-xs text-muted-foreground">{row.name}</p>
          </div>
        }
        back={{ onClick: onBack, label: row.name, testId: 'connection-logs-back' }}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isRefetching}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isRefetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        }
      />

      <RequestLogsTable
        entries={data?.entries ?? []}
        total={data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        isLoading={isLoading}
        columns={{ agent: true }}
        agentLabel={(agentSlug) => agentNames[agentSlug] ?? agentSlug}
      />
    </div>
  )
}
