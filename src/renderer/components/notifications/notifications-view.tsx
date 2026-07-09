import { ArrowRight, Bell, CheckCheck, ChevronLeft, ChevronRight, Loader2, Megaphone } from 'lucide-react'
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
import {
  usePlatformNotifications,
  usePlatformUnreadCount,
  useMarkPlatformNotificationsRead,
  useMarkAllPlatformNotificationsRead,
  type ApiPlatformNotification,
} from '@renderer/hooks/use-platform-notifications'
import { useRouteLocation } from '@renderer/router/use-route-location'
import { useNavigate } from '@tanstack/react-router'
import { AppLink } from '@renderer/components/ui/app-link'
import { useAgents } from '@renderer/hooks/use-agents'
import { PageTitle, SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { cn } from '@shared/lib/utils'
import { useRenderTracker } from '@renderer/lib/perf'
import { stripMarkdownPreview } from '@renderer/lib/markdown-preview'

function formatNotificationDate(date: Date): string {
  if (isToday(date)) return format(date, 'h:mm a').toLowerCase()
  if (isYesterday(date)) return 'yesterday'
  if (isThisYear(date)) return format(date, 'MMM d').toLowerCase()
  return format(date, 'MMM d, yyyy').toLowerCase()
}

const ROW_CLASS_NAME = 'group relative block w-full text-left focus-visible:outline-none'

function RowChrome({ isRead }: { isRead: boolean }) {
  return (
    <>
      <span
        aria-hidden
        className="absolute inset-y-0 -left-6 -right-2 rounded-md group-hover:bg-accent/40 group-focus-visible:ring-2 group-focus-visible:ring-ring transition-colors"
      />
      {/* Unread dot — sits in the bled gutter, left of the aligned content */}
      <span
        role={!isRead ? 'status' : undefined}
        className={cn(
          'absolute -left-4 top-1/2 -translate-y-1/2 h-1.5 w-1.5 rounded-full',
          !isRead ? 'bg-blue-500' : 'bg-transparent',
        )}
        aria-label={!isRead ? 'Unread' : undefined}
      />
    </>
  )
}

function RowTrailing({ isRead, dateLabel }: { isRead: boolean; dateLabel: string }) {
  return (
    <span className="shrink-0 flex items-center">
      <span
        className={cn(
          'w-24 text-right text-xs tabular-nums',
          !isRead ? 'text-foreground/80 font-medium' : 'text-muted-foreground',
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
  )
}

function NotificationRow({
  notification,
  agentName,
}: {
  notification: ApiNotification
  agentName: string | null
}) {
  const markRead = useMarkNotificationRead()

  // A chat-integration notification has no session to open — it lands on the
  // agent home; every other notification opens its session.
  const sessionId =
    notification.type !== 'session_chat_integration' ? notification.sessionId : null

  const handleClick = () => {
    // The <AppLink> owns the actual navigation now (real <a href> → web new-tab
    // on cmd-click).
    if (!notification.isRead) {
      markRead.mutate(notification.id)
    }
  }

  const dateLabel = formatNotificationDate(new Date(notification.createdAt))

  const content = (
    <>
      <RowChrome isRead={notification.isRead} />
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
        <RowTrailing isRead={notification.isRead} dateLabel={dateLabel} />
      </span>
    </>
  )

  // Two static AppLink targets (the union keeps `to`/`params` correlated) — the
  // session route when there's a session, else the agent home.
  return sessionId ? (
    <AppLink
      to="/agents/$slug/sessions/$sessionId"
      params={{ slug: notification.agentSlug, sessionId }}
      onClick={handleClick}
      className={ROW_CLASS_NAME}
    >
      {content}
    </AppLink>
  ) : (
    <AppLink
      to="/agents/$slug"
      params={{ slug: notification.agentSlug }}
      onClick={handleClick}
      className={ROW_CLASS_NAME}
    >
      {content}
    </AppLink>
  )
}

/**
 * Platform announcement row: no agent column (a Platform tag instead) and the
 * click opens the markdown detail view rather than navigating to a session.
 * Mark-read happens on detail open, not here.
 */
function PlatformNotificationRow({ notification }: { notification: ApiPlatformNotification }) {
  const isRead = Boolean(notification.read_at)
  const dateLabel = formatNotificationDate(new Date(notification.created_at))

  return (
    <AppLink
      to="/notifications/$id"
      params={{ id: notification.id }}
      className={ROW_CLASS_NAME}
      data-testid="platform-notification-row"
    >
      <RowChrome isRead={isRead} />
      <span className="relative flex items-center gap-4 py-3">
        <span className="w-56 shrink min-w-0 truncate text-xs flex items-center gap-1.5">
          <Megaphone className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span
            className={cn(
              'truncate',
              !isRead ? 'font-medium text-foreground' : 'text-foreground/90',
            )}
          >
            Platform
          </span>
        </span>
        <span className="flex-1 min-w-0 flex items-baseline gap-2 truncate">
          <span
            className={cn(
              'text-xs shrink-0 truncate max-w-[50%]',
              !isRead ? 'font-medium text-foreground' : 'text-foreground/90',
            )}
          >
            {notification.title}
          </span>
          <span className="text-xs text-muted-foreground truncate">
            {stripMarkdownPreview(notification.body)}
          </span>
        </span>
        <RowTrailing isRead={isRead} dateLabel={dateLabel} />
      </span>
    </AppLink>
  )
}

type MergedNotification =
  | { source: 'agent'; sortKey: number; agent: ApiNotification }
  | { source: 'platform'; sortKey: number; platform: ApiPlatformNotification }

const PAGE_SIZE = 15
// The platform list endpoint caps at 100 rows per read; announcements past
// that stop appearing in the merged history (they were read long ago anyway).
const PLATFORM_FETCH_CAP = 100

export function NotificationsView() {
  useRenderTracker('NotificationsView')
  const { selectedAgentSlug } = useRouteLocation()
  const navigate = useNavigate()
  const [page, setPage] = useState(0)
  // Merged pagination over two sources: fetch the top (page+1)*PAGE_SIZE of
  // EACH source, merge by date, then slice the requested window — correct as
  // long as each source can supply its own top-k.
  const fetchWindow = (page + 1) * PAGE_SIZE
  const { data, isLoading } = useNotifications(fetchWindow, 0)
  const { data: platformData, isLoading: isPlatformLoading } = usePlatformNotifications(
    Math.min(fetchWindow, PLATFORM_FETCH_CAP),
  )
  const { data: countData } = useUnreadNotificationCount()
  const { data: platformCountData } = usePlatformUnreadCount()
  const { data: agents } = useAgents()
  const markAllRead = useMarkAllNotificationsRead()
  const markAllPlatformRead = useMarkAllPlatformNotificationsRead()
  const unreadCount = (countData?.count ?? 0) + (platformCountData?.count ?? 0)

  const agentNameBySlug = useMemo(
    () => new Map(agents?.map((a) => [a.slug, a.name]) ?? []),
    [agents],
  )

  const merged = useMemo<MergedNotification[]>(() => {
    const agentItems: MergedNotification[] = (data?.items ?? []).map((n) => ({
      source: 'agent',
      sortKey: new Date(n.createdAt).getTime(),
      agent: n,
    }))
    const platformItems: MergedNotification[] = (platformData?.notifications ?? []).map((n) => ({
      source: 'platform',
      sortKey: new Date(n.created_at).getTime(),
      platform: n,
    }))
    return [...agentItems, ...platformItems].sort((a, b) => b.sortKey - a.sortKey)
  }, [data?.items, platformData?.notifications])

  const total = (data?.total ?? 0) + (platformData?.total ?? 0)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages - 1)
  const pageItems = merged.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE)

  const handleMarkAllRead = () => {
    markAllRead.mutate()
    if ((platformCountData?.count ?? 0) > 0) {
      markAllPlatformRead.mutate()
    }
  }

  return (
    <SettingsPageContainer fullScreen>
      <PageTitle
        title="Notifications"
        back={{
          onClick: () => {
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
            onClick={handleMarkAllRead}
            disabled={markAllRead.isPending || markAllPlatformRead.isPending || unreadCount === 0}
            data-testid="notifications-mark-all-read"
          >
            <CheckCheck className="h-3.5 w-3.5 mr-1.5" />
            Mark all as read
          </Button>
        }
      />

      {isLoading || isPlatformLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading notifications...
        </div>
      ) : pageItems.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center text-sm text-muted-foreground">
          <Bell className="h-8 w-8 mx-auto mb-3 opacity-20" />
          No notifications yet.
        </div>
      ) : (
        <>
          <div>
            {pageItems.map((entry) =>
              entry.source === 'agent' ? (
                <NotificationRow
                  key={`agent-${entry.agent.id}`}
                  notification={entry.agent}
                  agentName={agentNameBySlug.get(entry.agent.agentSlug) ?? null}
                />
              ) : (
                <PlatformNotificationRow
                  key={`platform-${entry.platform.id}`}
                  notification={entry.platform}
                />
              ),
            )}
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
