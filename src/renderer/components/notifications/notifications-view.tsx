import { ArrowRight, Bell, Check, CheckCheck, ChevronLeft, ChevronRight, Loader2, Megaphone } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { format, isToday, isYesterday, isThisYear } from 'date-fns'
import { Button } from '@renderer/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import {
  useNotifications,
  useUnreadNotificationCount,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  type ApiNotification,
} from '@renderer/hooks/use-notifications'
import {
  NOTIFICATION_FILTERS,
  NOTIFICATION_TYPES,
  notificationFilterSchema,
  notificationFilterTypes,
  type NotificationFilter,
  type NotificationTypeCounts,
} from '@shared/lib/notifications/notification-filters'
import {
  usePlatformNotifications,
  usePlatformUnreadCount,
  useMarkAllPlatformNotificationsRead,
  useMarkPlatformNotificationsRead,
  type ApiPlatformNotification,
} from '@renderer/hooks/use-platform-notifications'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { AppLink } from '@renderer/components/ui/app-link'
import { useAgents } from '@renderer/hooks/use-agents'
import { SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { cn } from '@shared/lib/utils'
import { useRenderTracker } from '@renderer/lib/perf'
import { stripMarkdownPreview } from '@shared/lib/markdown-preview'
import { UnreadDot } from '@renderer/components/agents/status-indicators'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import type { ApiAgent } from '@shared/lib/types/api'

function formatNotificationDate(date: Date): string {
  if (isToday(date)) return format(date, 'h:mm a').toLowerCase()
  if (isYesterday(date)) return 'yesterday'
  if (isThisYear(date)) return format(date, 'MMM d').toLowerCase()
  return format(date, 'MMM d, yyyy').toLowerCase()
}

const ROW_CLASS_NAME = 'group relative block w-full text-left focus-visible:outline-none'
const ROW_CONTENT_CLASS_NAME = 'relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-3 sm:flex sm:gap-4'
const ROW_AGENT_CLASS_NAME = 'min-w-0 truncate text-xs flex items-center gap-2 sm:w-56 sm:shrink'
const ROW_MESSAGE_CLASS_NAME = 'col-start-1 row-start-2 min-w-0 flex flex-col items-start truncate sm:flex-1 sm:flex-row sm:items-baseline sm:gap-2'

function RowChrome({ isRead, mention = false }: { isRead: boolean; mention?: boolean }) {
  return (
    <>
      <span
        aria-hidden
        className="absolute inset-y-0 -left-6 -right-2 rounded-item group-hover:bg-accent/40 group-focus-visible:ring-2 group-focus-visible:ring-ring transition-colors"
      />
      {/* Unread dot — sits in the bled gutter, left of the aligned content. A mention is an @. */}
      {!isRead && mention ? (
        <UnreadDot mention className="absolute -left-5 top-1/2 -translate-y-1/2" />
      ) : <span
        role={!isRead ? 'status' : undefined}
        className={cn(
          'absolute -left-4 top-1/2 -translate-y-1/2 h-1.5 w-1.5 rounded-full',
          !isRead ? 'bg-blue-500' : 'bg-transparent',
        )}
        aria-label={!isRead ? 'Unread' : undefined}
      />}
    </>
  )
}

function RowTrailing({ isRead, dateLabel }: { isRead: boolean; dateLabel: string }) {
  // An unread row's check sits over this gap (see MarkReadButton), so the time slides clear of it.
  return (
    <span className="col-start-2 row-start-1 row-span-2 shrink-0 flex items-center">
      <span
        className={cn(
          'w-24 text-right text-xs tabular-nums',
          !isRead ? 'text-foreground/80 font-medium' : 'text-muted-foreground',
        )}
      >
        {dateLabel}
      </span>
      {!isRead && (
        <span aria-hidden className="w-0 transition-all duration-200 ease-out group-hover:w-7 group-focus-within:w-7" />
      )}
      {/* Inline chevron affordance — width animates from 0 on row hover,
          nudging the timestamp left while it slides into view */}
      <span
        aria-hidden
        className="flex justify-center overflow-hidden w-0 opacity-0 transition-all duration-200 ease-out group-hover:w-6 group-hover:opacity-100 group-focus-within:w-6 group-focus-within:opacity-100"
      >
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </span>
    </span>
  )
}

/**
 * A row and, while it is unread, a hover check that marks it read without
 * opening it. The check is the link's sibling (a button can't sit inside an
 * <a>); the frame is a `group` too, so hovering the check keeps the row lit.
 */
function RowFrame({
  children,
  isRead,
  onMarkRead,
}: {
  children: ReactNode
  isRead: boolean
  onMarkRead: () => void
}) {
  return (
    <div className="group relative" data-testid="notification-row">
      {children}
      {!isRead && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Mark as read"
                data-testid="notification-mark-read"
                onClick={onMarkRead}
                className="absolute right-6 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-control text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Mark as read</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  )
}

function NotificationRow({
  notification,
  agent,
}: {
  notification: ApiNotification
  agent: ApiAgent | null
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
      <RowChrome isRead={notification.isRead} mention={notification.type === 'session_mention'} />
      {/* Content — no negative margins, so left/right edges match the page
          title and pagination exactly */}
      <span className={ROW_CONTENT_CLASS_NAME}>
        <span
          className={ROW_AGENT_CLASS_NAME}
          title={notification.agentSlug}
        >
          {/* A fixed slot, so names line up when an older deployment has no avatar. */}
          <span className="flex size-4 shrink-0 items-center justify-center">
            {agent && <AgentAvatar agent={agent} size={16} />}
          </span>
          <span
            className={cn(
              'truncate',
              !notification.isRead ? 'font-medium text-foreground' : 'text-foreground/90',
            )}
          >
            {agent?.name ?? notification.agentSlug}
          </span>
        </span>
        <span className={ROW_MESSAGE_CLASS_NAME}>
          <span
            className={cn(
              'text-xs shrink-0 truncate max-w-full sm:max-w-[50%]',
              !notification.isRead ? 'font-medium text-foreground' : 'text-foreground/90',
            )}
          >
            {notification.title}
          </span>
          <span className="max-w-full text-xs text-muted-foreground truncate">
            {notification.body}
          </span>
        </span>
        <RowTrailing isRead={notification.isRead} dateLabel={dateLabel} />
      </span>
    </>
  )

  // Two static AppLink targets (the union keeps `to`/`params` correlated) — the
  // session route when there's a session, else the agent home.
  const link = sessionId ? (
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

  return (
    <RowFrame isRead={notification.isRead} onMarkRead={() => markRead.mutate(notification.id)}>
      {link}
    </RowFrame>
  )
}

/**
 * Platform announcement row: no agent column (a Platform tag instead) and the
 * click opens the markdown detail view rather than navigating to a session.
 * Opening the detail marks it read; so does the row's hover check.
 */
function PlatformNotificationRow({ notification }: { notification: ApiPlatformNotification }) {
  const isRead = Boolean(notification.read_at)
  const dateLabel = formatNotificationDate(new Date(notification.created_at))
  const markRead = useMarkPlatformNotificationsRead()

  return (
    <RowFrame isRead={isRead} onMarkRead={() => markRead.mutate([notification.id])}>
      <AppLink
        to="/notifications/$id"
        params={{ id: notification.id }}
        className={ROW_CLASS_NAME}
        data-testid="platform-notification-row"
      >
        <RowChrome isRead={isRead} />
        <span className={ROW_CONTENT_CLASS_NAME}>
          <span className={ROW_AGENT_CLASS_NAME}>
            <span className="flex size-4 shrink-0 items-center justify-center">
              <Megaphone className="h-3 w-3 text-muted-foreground" />
            </span>
            <span
              className={cn(
                'truncate',
                !isRead ? 'font-medium text-foreground' : 'text-foreground/90',
              )}
            >
              Platform
            </span>
          </span>
          <span className={ROW_MESSAGE_CLASS_NAME}>
            <span
              className={cn(
                'text-xs shrink-0 truncate max-w-full sm:max-w-[50%]',
                !isRead ? 'font-medium text-foreground' : 'text-foreground/90',
              )}
            >
              {notification.title}
            </span>
            <span className="max-w-full text-xs text-muted-foreground truncate">
              {stripMarkdownPreview(notification.body)}
            </span>
          </span>
          <RowTrailing isRead={isRead} dateLabel={dateLabel} />
        </span>
      </AppLink>
    </RowFrame>
  )
}

const FILTER_LABELS: Record<NotificationFilter, string> = {
  all: 'All',
  'needs-you': 'Needs you',
  mentions: 'Mentions',
  completed: 'Completed',
  automations: 'Automations',
  announcements: 'Announcements',
}

const EMPTY_MESSAGES: Record<NotificationFilter, string> = {
  all: 'No notifications yet.',
  'needs-you': 'Nothing needs you right now.',
  mentions: 'No one has mentioned you yet.',
  completed: 'No completed sessions yet.',
  automations: 'No scheduled, webhook or chat runs yet.',
  announcements: 'No announcements yet.',
}

/** Total and unread rows a filter covers, including non-actionable types. */
function filterTally(
  filter: NotificationFilter,
  typeCounts: NotificationTypeCounts | undefined,
  platform: { total: number; unread: number },
): { total: number; unread: number } {
  if (filter === 'announcements') return platform
  const types = notificationFilterTypes(filter) ?? NOTIFICATION_TYPES
  return types.reduce(
    (sum, type) => ({
      total: sum.total + (typeCounts?.[type].total ?? 0),
      unread: sum.unread + (typeCounts?.[type].unread ?? 0),
    }),
    filter === 'all' ? platform : { total: 0, unread: 0 },
  )
}

/** The same segmented tabs as the Add New Connection dialog's All / APIs / MCPs. */
function NotificationFilterTabs({
  tallies,
}: {
  tallies: Record<NotificationFilter, { total: number; unread: number }>
}) {
  return (
    <TabsList aria-label="Filter notifications" className="h-8 max-w-full justify-start overflow-x-auto p-0.5">
      {NOTIFICATION_FILTERS.map((filter) => {
        const unread = filter === 'all' ? 0 : tallies[filter].unread
        return (
          <TabsTrigger
            key={filter}
            value={filter}
            data-testid={`notifications-filter-${filter}`}
            className="group h-full shrink-0 gap-1.5 py-0 text-xs"
          >
            {FILTER_LABELS[filter]}
            {unread > 0 && (
              <span
                className="tabular-nums text-muted-foreground/70 group-data-[state=active]:text-foreground/60"
                aria-label={`${unread} unread`}
              >
                {unread}
              </span>
            )}
          </TabsTrigger>
        )
      })}
    </TabsList>
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
  const navigate = useNavigate()
  const routeSearch = useSearch({ strict: false }) as { filter?: string }
  const parsedFilter = notificationFilterSchema.safeParse(routeSearch.filter)
  const filter: NotificationFilter = parsedFilter.success ? parsedFilter.data : 'all'
  const agentTypes = notificationFilterTypes(filter)
  const showsAgent = filter !== 'announcements'
  const showsPlatform = filter === 'all' || filter === 'announcements'

  // The page belongs to the filter it was chosen under: switching tabs (or
  // back/forward to another filter) starts on page one.
  const [pageState, setPageState] = useState<{ filter: NotificationFilter; page: number }>({ filter, page: 0 })
  if (pageState.filter !== filter) setPageState({ filter, page: 0 })
  const page = pageState.filter === filter ? pageState.page : 0
  const setPage = (update: (p: number) => number) => setPageState({ filter, page: update(page) })

  // Merged pagination over two sources: fetch the top (page+1)*PAGE_SIZE of
  // EACH source, merge by date, then slice the requested window — correct as
  // long as each source can supply its own top-k. A filter that shows one
  // source skips the other's rows (platform still fetches one row so its
  // total can decide whether the Announcements tab shows).
  const fetchWindow = (page + 1) * PAGE_SIZE
  const { data, isLoading } = useNotifications(fetchWindow, 0, { types: agentTypes, enabled: showsAgent })
  const { data: platformData, isLoading: isPlatformLoading } = usePlatformNotifications(
    showsPlatform ? Math.min(fetchWindow, PLATFORM_FETCH_CAP) : 1,
  )
  const { data: platformCountData } = usePlatformUnreadCount()
  const { data: countData } = useUnreadNotificationCount()
  const { data: agents } = useAgents()
  const markAllRead = useMarkAllNotificationsRead()
  const markAllPlatformRead = useMarkAllPlatformNotificationsRead()

  const platformTally = {
    total: Math.min(platformData?.total ?? 0, PLATFORM_FETCH_CAP),
    unread: platformCountData?.count ?? 0,
  }
  const tallies = Object.fromEntries(
    NOTIFICATION_FILTERS.map((f) => [f, filterTally(f, countData?.types, platformTally)]),
  ) as Record<NotificationFilter, { total: number; unread: number }>

  const agentItems = useMemo(() => (showsAgent ? (data?.items ?? []) : []), [showsAgent, data?.items])
  const platformItems = useMemo(
    () => (showsPlatform ? (platformData?.notifications ?? []) : []),
    [showsPlatform, platformData?.notifications],
  )

  // The badge count skips non-actionable types (e.g. scheduled task started), but
  // the list still shows them as unread and read-all clears them.
  const hasUnread = tallies[filter].unread > 0 ||
    agentItems.some((n) => !n.isRead) || platformItems.some((n) => !n.read_at)

  const agentBySlug = useMemo(
    () => new Map(agents?.map((a) => [a.slug, a]) ?? []),
    [agents],
  )

  const merged = useMemo<MergedNotification[]>(() => {
    const agentRows: MergedNotification[] = agentItems.map((n) => ({
      source: 'agent',
      sortKey: new Date(n.createdAt).getTime(),
      agent: n,
    }))
    const platformRows: MergedNotification[] = platformItems.map((n) => ({
      source: 'platform',
      sortKey: new Date(n.created_at).getTime(),
      platform: n,
    }))
    return [...agentRows, ...platformRows].sort((a, b) => b.sortKey - a.sortKey)
  }, [agentItems, platformItems])

  // Clamp the platform contribution to what the capped fetch can actually
  // supply — otherwise >100 platform rows advertise pages whose slice of
  // `merged` is empty, stranding the user past the last real page.
  const total = (showsAgent ? (data?.total ?? 0) : 0) + (showsPlatform ? platformTally.total : 0)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages - 1)
  const pageItems = merged.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE)

  const handleMarkAllRead = () => {
    if (showsAgent) markAllRead.mutate(agentTypes)
    if (showsPlatform && platformTally.unread > 0) {
      markAllPlatformRead.mutate()
    }
  }

  const selectFilter = (next: NotificationFilter) => {
    void navigate({ to: '/notifications', search: next === 'all' ? {} : { filter: next } })
  }

  return (
    <SettingsPageContainer fullScreen className="pt-10">
      <Tabs
        value={filter}
        onValueChange={(value) => {
          const next = notificationFilterSchema.safeParse(value)
          if (next.success) selectFilter(next.data)
        }}
        className="space-y-6"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="sr-only">Notifications</h2>
            <NotificationFilterTabs tallies={tallies} />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 self-end sm:self-auto"
            onClick={handleMarkAllRead}
            disabled={markAllRead.isPending || markAllPlatformRead.isPending || !hasUnread}
            data-testid="notifications-mark-all-read"
          >
            <CheckCheck className="h-3.5 w-3.5 mr-1.5" />
            {filter === 'all' ? 'Mark all as read' : 'Mark these as read'}
          </Button>
        </div>

        <TabsContent value={filter} className="mt-0">
          {(showsAgent && isLoading) || (showsPlatform && isPlatformLoading) ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading notifications...
            </div>
          ) : pageItems.length === 0 ? (
            <div className="rounded-card border border-dashed p-12 text-center text-sm text-muted-foreground">
              <Bell className="h-8 w-8 mx-auto mb-3 opacity-20" />
              {EMPTY_MESSAGES[filter]}
            </div>
          ) : (
            <>
              <div>
                {pageItems.map((entry) =>
                  entry.source === 'agent' ? (
                    <NotificationRow
                      key={`agent-${entry.agent.id}`}
                      notification={entry.agent}
                      agent={agentBySlug.get(entry.agent.agentSlug) ?? null}
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
                      aria-label="Previous page"
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
                      aria-label="Next page"
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
        </TabsContent>
      </Tabs>
    </SettingsPageContainer>
  )
}
