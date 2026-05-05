import { useState } from 'react'
import { RelatedSessions, type SortOrder } from '@renderer/components/sessions/related-sessions'
import { SortPopover } from '@renderer/components/sessions/sort-popover'

type RelatedSessionItem = Parameters<typeof RelatedSessions>[0]['sessions'][number]

interface RunHistorySectionProps {
  sessions: RelatedSessionItem[]
  agentSlug: string
  formatDate: (date: string) => string
  formatSubtext?: (date: string) => string
  emptyMessage: string
  title?: string
  pageSize?: number
}

export function RunHistorySection({
  sessions,
  agentSlug,
  formatDate,
  formatSubtext,
  emptyMessage,
  title = 'Run History',
  pageSize = 15,
}: RunHistorySectionProps) {
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest')

  return (
    <div className="pb-6">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-muted-foreground flex-1">{title}</h3>
        {sessions.length > 0 && (
          <SortPopover value={sortOrder} onChange={setSortOrder} ariaLabel="Sort runs" />
        )}
      </div>
      <div className="border-b mt-2" />
      {sessions.length > 0 ? (
        <RelatedSessions
          sessions={sessions}
          formatDate={formatDate}
          formatSubtext={formatSubtext}
          agentSlug={agentSlug}
          showIcon={false}
          showHeader={false}
          sortOrder={sortOrder}
          dateAsTitle
          pageSize={pageSize}
        />
      ) : (
        <div className="rounded-lg border border-dashed p-4 mt-3 text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      )}
    </div>
  )
}
