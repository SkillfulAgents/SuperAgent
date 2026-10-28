import { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Loader2 } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { SettingsPageContainer, PageTitle } from '@renderer/components/layout/settings-page'
import { RelatedSessions, type SortOrder } from '@renderer/components/sessions/related-sessions'
import { SortPopover } from '@renderer/components/sessions/sort-popover'
import { SectionHeader } from '@renderer/components/ui/section-header'
import { useCompletedOneTimeSessions } from '@renderer/hooks/use-scheduled-tasks'

interface CompletedTasksViewProps {
  agentSlug: string
}

function formatSessionDate(date: string) {
  return formatDistanceToNow(new Date(date), { addSuffix: true })
}

export function CompletedTasksView({ agentSlug }: CompletedTasksViewProps) {
  const navigate = useNavigate()
  const { data: sessions = [], isLoading, error } = useCompletedOneTimeSessions(agentSlug)
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest')

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading completed one-time tasks...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center text-destructive">
        Failed to load completed one-time tasks
      </div>
    )
  }

  return (
    <SettingsPageContainer fullScreen>
      <PageTitle
        title="Completed One-time Tasks"
        back={{
          onClick: () => {
            void navigate({ to: '/agents/$slug', params: { slug: agentSlug } })
          },
          testId: 'completed-tasks-back-button',
        }}
      />

      <section className="max-w-3xl">
        <SectionHeader
          title={`Sessions (${sessions.length})`}
          actions={sessions.length > 1 ? (
            <SortPopover value={sortOrder} onChange={setSortOrder} ariaLabel="Sort completed sessions" />
          ) : undefined}
        />

        {sessions.length === 0 ? (
          <p className="py-6 text-xs text-muted-foreground">
            No completed one-time sessions yet.
          </p>
        ) : (
          <RelatedSessions
            sessions={sessions}
            formatDate={formatSessionDate}
            showHeader={false}
            agentSlug={agentSlug}
            sortOrder={sortOrder}
            pageSize={15}
          />
        )}
      </section>
    </SettingsPageContainer>
  )
}
