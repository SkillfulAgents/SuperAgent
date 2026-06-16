import { ArrowRight, Bell, CheckCheck, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { format, isToday, isYesterday, isThisYear } from 'date-fns'
import { Button } from '@renderer/components/ui/button'
import {
  useNotifications,
  useUnreadNotificationCount,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  type ApiNotification,
} from '@renderer/hooks/use-notifications'
import { useSelection } from '@renderer/context/selection-context'
import { useNavigate } from '@tanstack/react-router'
import { useAgents } from '@renderer/hooks/use-agents'
import { PageTitle, SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { cn } from '@shared/lib/utils'
import { useRenderTracker } from '@renderer/lib/perf'

function formatNotificationDate(date: Date): string {
  if (isToday(date)) return format(date, 'h:mm a').toLowerCase()
  if (isYesterday(date)) return 'yesterday'
  if (isThisYear(date)) return format(date, 'MMM d').toLowerCase()
  return format(date, 'MMM d, yyyy').toLowerCase()
}

function NotificationRow({
  notification,
  agentName,
}: {
  notification: ApiNotification
  agentName: string | null
}) {
  const markRead = useMarkNotificationRead()
  const { setAgent } = useSelection()
  const navigate = useNavigate()

  const handleClick = () => {
    if (notification.type === 'session_chat_integration') {
      setAgent(notification.agentSlug, { kind: 'home' })
    } else {
      setAgent(notification.agentSlug, { kind: 'session', id: notification.sessionId })
    }
    void navigate({ to: '/agents/$slug', params: { slug: notification.agentSlug } })
    if (!notification.isRead) {
      markRead.mutate(notification.id)
    }
  }

  const dateLabel = formatNotificationDate(new Date(notification.createdAt))

  return (
    <button
      onClick={handleClick}
      className="group relative block w-full text-left focus-visible:outline-none"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 -left-6 -right-2 rounded-md group-hover:bg-accent/40 group-focus-visible:ring-2 group-focus-visible:ring-ring transition-colors"
      />
      {/* Unread dot — sits in the bled gutter, left of the aligned content */}
      <span
        role={!notification.isRead ? 'status' : undefined}
        className={cn(
          'absolute -left-4 top-1/2 -translate-y-1/2 h-1.5 w-1.5 rounded-full',
          !notification.isRead ? 'bg-blue-500' : 'bg-transparent',
        )}
        aria-label={!notification.isRead ? 'Unread' : undefined}
      />
      {/* Content — no negative margins, so left/right edges match the page
          title and pagination exactly */}
      <span className="relative flex items-center gap-4 py-3">
        <span
          className="w-56 shrink min-w-0 truncate text-xs flex items-baseline gap-1.5"
          title={notification.agentSlug}
        >
          <span
            className={cn(
              'truncate',
              !notification.isRead ? 'font-medium text-foreground' : 'text-foreground/90',
            )}
          >
            {agentName ?? notification.agentSlug}
          </span>
          {agentName && (
            <span className="text-muted-foreground/60 font-mono text-[10px] shrink-0">
              {notification.agentSlug.split('-').pop()}
            </span>
          )}
        </span>
        <span className="flex-1 min-w-0 flex items-baseline gap-2 truncate">
          <span
            className={cn(
              'text-xs shrink-0 truncate max-w-[50%]',
              !notification.isRead ? 'font-medium text-foreground' : 'text-foreground/90',
            )}
          >
            {notification.title}
          </span>
          <span className="text-xs text-muted-foreground truncate">
            {notification.body}
          </span>
        </span>
        <span className="shrink-0 flex items-center">
          <span
            className={cn(
              'w-24 text-right text-xs tabular-nums',
              !notification.isRead ? 'text-foreground/80 font-medium' : 'text-muted-foreground',
            )}
          >
            {dateLabel}
          </span>
          {/* Inline chevron affordance — width animates from 0 on row hover,
              nudging the timestamp left while it slides into view */}
          <span
            aria-hidden
            className="flex justify-center overflow-hidden w-0 opacity-0 transition-all duration-200 ease-out group-hover:w-6 group-hover:opacity-100"
          >
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </span>
        </span>
      </span>
    </button>
  )
}

const PAGE_SIZE = 15

export function NotificationsView() {
  useRenderTracker('NotificationsView')
  const { setView, selectedAgentSlug } = useSelection()
  const navigate = useNavigate()
  const [page, setPage] = useState(0)
  const offset = page * PAGE_SIZE
  const { data, isLoading } = useNotifications(PAGE_SIZE, offset)
  const { data: countData } = useUnreadNotificationCount()
  const { data: agents } = useAgents()
  const markAllRead = useMarkAllNotificationsRead()
  const unreadCount = countData?.count ?? 0

  const agentNameBySlug = useMemo(
    () => new Map(agents?.map((a) => [a.slug, a.name]) ?? []),
    [agents],
  )

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages - 1)

  return (
    <SettingsPageContainer fullScreen>
      <PageTitle
        title="Notifications"
        back={{
          onClick: () => {
            setView({ kind: 'home' })
            void navigate(
              selectedAgentSlug
                ? { to: '/agents/$slug', params: { slug: selectedAgentSlug } }
                : { to: '/' },
            )
          },
          testId: 'notifications-back-button',
        }}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => markAllRead.mutate()}
            disabled={markAllRead.isPending || unreadCount === 0}
            data-testid="notifications-mark-all-read"
          >
            <CheckCheck className="h-3.5 w-3.5 mr-1.5" />
            Mark all as read
          </Button>
        }
      />

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading notifications...
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center text-sm text-muted-foreground">
          <Bell className="h-8 w-8 mx-auto mb-3 opacity-20" />
          No notifications yet.
        </div>
      ) : (
        <>
          <div>
            {items.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                agentName={agentNameBySlug.get(notification.agentSlug) ?? null}
              />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <span className="text-xs text-muted-foreground">
                {total} total
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setPage((p) => p - 1)}
                  disabled={currentPage === 0}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <span className="text-xs text-muted-foreground px-2">
                  {currentPage + 1} / {totalPages}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={currentPage >= totalPages - 1}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </SettingsPageContainer>
  )
}
