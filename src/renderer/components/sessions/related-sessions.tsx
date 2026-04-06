import { useState } from 'react'
import { MessageSquare, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useSelection } from '@renderer/context/selection-context'

interface SessionItem {
  id: string
  name: string
  createdAt: string
}

interface RelatedSessionsProps {
  sessions: SessionItem[]
  formatDate: (date: string) => string
  className?: string
}

const PAGE_SIZE = 10

export function RelatedSessions({ sessions, formatDate, className }: RelatedSessionsProps) {
  const [page, setPage] = useState(0)
  const totalPages = Math.ceil(sessions.length / PAGE_SIZE)
  const paginated = sessions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const { selectSession } = useSelection()

  if (sessions.length === 0) return null

  return (
    <div className={className}>
      <h3 className="text-sm font-medium text-muted-foreground mb-2">
        Related Sessions ({sessions.length})
      </h3>
      <div className="space-y-2">
        {paginated.map((session) => (
          <button
            key={session.id}
            onClick={() => selectSession(session.id)}
            className="w-full flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors text-left"
          >
            <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{session.name}</div>
              <div className="text-xs text-muted-foreground">
                {formatDate(session.createdAt)}
              </div>
            </div>
          </button>
        ))}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => p - 1)}
            disabled={page === 0}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= totalPages - 1}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
