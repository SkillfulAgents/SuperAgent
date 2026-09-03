import { useMemo, useRef, useState } from 'react'
import { MessageSquare, ChevronLeft, ChevronRight, MoreVertical, MoonStar } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { WorkingDots, AwaitingDot } from '@renderer/components/agents/status-indicators'
import { HighlightMatch } from '@renderer/components/ui/highlight-match'
import { Button } from '@renderer/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { useRouteLocation } from '@renderer/router/use-route-location'
import { useNavigate } from '@tanstack/react-router'
import { SessionContextMenu } from '@renderer/components/sessions/session-context-menu'
import { sortSessionsByActivity, type SessionSortOrder } from '@shared/lib/session-ordering'

interface SessionItem {
  id: string
  name: string
  createdAt: string
  lastActivityAt?: string
  isActive?: boolean
  isAwaitingInput?: boolean
  hasUnreadNotifications?: boolean
  pendingWakeAt?: string
}

interface RelatedSessionsProps {
  sessions: SessionItem[]
  formatDate: (date: string) => string
  className?: string
  showIcon?: boolean
  title?: string
  showHeader?: boolean
  agentSlug?: string
  searchQuery?: string
  sortOrder?: SortOrder
  dateAsTitle?: boolean
  formatSubtext?: (date: string) => string
  pageSize?: number
}

export type SortOrder = SessionSortOrder

const DEFAULT_PAGE_SIZE = 10

export function RelatedSessions({ sessions, formatDate, className, showIcon = true, title, showHeader = true, agentSlug, searchQuery, sortOrder: sortOrderProp, dateAsTitle = false, formatSubtext, pageSize = DEFAULT_PAGE_SIZE }: RelatedSessionsProps) {
  const [page, setPage] = useState(0)
  const [sortOrderInternal, setSortOrder] = useState<SortOrder>('newest')
  const sortOrder = sortOrderProp ?? sortOrderInternal

  const filtered = useMemo(() => {
    if (!searchQuery?.trim()) return sessions
    const q = searchQuery.toLowerCase()
    return sessions.filter((s) => s.name.toLowerCase().includes(q))
  }, [sessions, searchQuery])

  const sorted = useMemo(() => sortSessionsByActivity(filtered, sortOrder), [filtered, sortOrder])

  // Reset page when search query changes
  const prevQuery = useRef(searchQuery)
  if (prevQuery.current !== searchQuery) {
    prevQuery.current = searchQuery
    if (page !== 0) setPage(0)
  }

  const totalPages = Math.ceil(sorted.length / pageSize)
  const paginated = sorted.slice(page * pageSize, (page + 1) * pageSize)

  if (sessions.length === 0) return null

  return (
    <div className={className}>
      {showHeader && (
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-muted-foreground">
            {title ?? 'Related Sessions'}
          </h3>
          <Select value={sortOrder} onValueChange={(v) => { setSortOrder(v as SortOrder); setPage(0) }}>
            <SelectTrigger className="h-7 w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="divide-y divide-border/50">
        {paginated.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            showIcon={showIcon}
            formatDate={formatDate}
            agentSlug={agentSlug}
            searchQuery={searchQuery}
            dateAsTitle={dateAsTitle}
            formatSubtext={formatSubtext}
          />
        ))}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => setPage((p) => p - 1)}
              disabled={page === 0}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= totalPages - 1}
              aria-label="Next page"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function SessionRow({ session, showIcon, formatDate, agentSlug: agentSlugProp, searchQuery, dateAsTitle = false, formatSubtext }: { session: SessionItem; showIcon: boolean; formatDate: (date: string) => string; agentSlug?: string; searchQuery?: string; dateAsTitle?: boolean; formatSubtext?: (date: string) => string }) {
  const { selectedAgentSlug } = useRouteLocation()
  const navigate = useNavigate()
  const agentSlug = agentSlugProp ?? selectedAgentSlug
  const selectSession = (id: string) => {
    if (agentSlug) {
      void navigate({ to: '/agents/$slug/sessions/$sessionId', params: { slug: agentSlug, sessionId: id } })
    }
  }

  const row = (
    <div
      role="button"
      tabIndex={0}
      className="group relative w-full flex items-center gap-3 py-3 px-1 hover:bg-muted/50 transition-colors text-left cursor-pointer"
      onClick={() => selectSession(session.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          selectSession(session.id)
        }
      }}
    >
      {showIcon && <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0" />}
      <div className="flex-1 min-w-0">
        <div className={`text-xs truncate flex items-center gap-2 ${dateAsTitle ? 'font-normal' : 'font-medium'}`}>
          {session.isAwaitingInput ? (
            <AwaitingDot />
          ) : session.isActive ? (
            <WorkingDots />
          ) : session.hasUnreadNotifications ? (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />
          ) : null}
          {session.pendingWakeAt && !session.isActive && !session.isAwaitingInput && (
            <span
              className="flex items-center gap-1 shrink-0 text-muted-foreground font-normal"
              title={`Resumes ${formatDistanceToNow(new Date(session.pendingWakeAt), { addSuffix: true })}`}
            >
              <MoonStar className="h-3 w-3" />
              {formatDistanceToNow(new Date(session.pendingWakeAt), { addSuffix: true })}
            </span>
          )}
          {dateAsTitle ? (
            <>
              <span>{formatDate(session.createdAt)}</span>
              {formatSubtext && (
                <span className="text-xs font-normal text-muted-foreground">
                  {formatSubtext(session.createdAt)}
                </span>
              )}
            </>
          ) : (
            <HighlightMatch text={session.name} query={searchQuery ?? ''} />
          )}
        </div>
        {!dateAsTitle && (
          <div className="text-xs text-muted-foreground truncate">
            {/* Match the activity ordering: the stamp is the last chat, not the creation date. */}
            {formatDate(session.lastActivityAt ?? session.createdAt)}
          </div>
        )}
      </div>
      {agentSlug && (
        <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity">
          {/* Three-dot = the same session menu a right-click on this row (or
              the sidebar row) opens, so the two never drift apart. A click
              replays as a contextmenu event that bubbles to the row's trigger,
              anchored under this button. */}
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-6 w-6"
            aria-label={`Actions for ${session.name}`}
            data-testid={`session-row-menu-${session.id}`}
            onClick={(e) => {
              e.stopPropagation()
              const rect = e.currentTarget.getBoundingClientRect()
              e.currentTarget.dispatchEvent(
                new MouseEvent('contextmenu', {
                  bubbles: true,
                  cancelable: true,
                  clientX: rect.left,
                  clientY: rect.bottom + 4,
                })
              )
            }}
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  )

  // Rows without an agent (none today, but the props allow it) have no menu
  // to offer; everywhere else the row is the menu's trigger.
  if (!agentSlug) return row
  return (
    <SessionContextMenu
      sessionId={session.id}
      sessionName={session.name}
      agentSlug={agentSlug}
      activity={{
        isActive: !!session.isActive,
        isAwaitingInput: !!session.isAwaitingInput,
        // The list has no stream handle; a session mid-stream is also isActive.
        isStreaming: false,
      }}
    >
      {row}
    </SessionContextMenu>
  )
}
