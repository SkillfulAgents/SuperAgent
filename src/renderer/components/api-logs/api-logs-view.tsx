import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { Button } from '@renderer/components/ui/button'
import { PageTitle, SettingsPageContainer } from '@renderer/components/layout/settings-page'
import {
  REQUEST_LOG_PAGE_SIZE,
  RequestLogsTable,
} from '@renderer/components/api-logs/request-logs-table'
import { useRenderTracker } from '@renderer/lib/perf'
import type { RequestLogPage } from '@shared/lib/types/request-log'

interface ApiLogsViewProps {
  agentSlug: string
}

export function ApiLogsView({ agentSlug }: ApiLogsViewProps) {
  useRenderTracker('ApiLogsView')
  const navigate = useNavigate()
  const [page, setPage] = useState(0)
  const { track } = useAnalyticsTracking()

  useEffect(() => {
    track('api_logs_viewed')
  }, [track])

  const { data, isLoading, refetch, isRefetching } = useQuery<RequestLogPage>({
    queryKey: ['agent-audit-log', agentSlug, page],
    queryFn: async () => {
      const res = await apiFetch(
        `/api/agents/${agentSlug}/audit-log?offset=${page * REQUEST_LOG_PAGE_SIZE}&limit=${REQUEST_LOG_PAGE_SIZE}`,
      )
      if (!res.ok) throw new Error('Failed to fetch audit log')
      return res.json()
    },
  })

  return (
    <SettingsPageContainer fullScreen>
      <PageTitle
        title="API Logs"
        back={{
          onClick: () => {
            void navigate({ to: '/agents/$slug', params: { slug: agentSlug } })
          },
          testId: 'api-logs-back-button',
        }}
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
        columns={{ source: true, toolkit: true }}
      />
    </SettingsPageContainer>
  )
}
