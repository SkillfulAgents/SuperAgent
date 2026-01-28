import { Bell, CheckCheck } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@renderer/components/ui/popover'
import { Button } from '@renderer/components/ui/button'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import {
  useNotifications,
  useUnreadNotificationCount,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  type ApiNotification,
} from '@renderer/hooks/use-notifications'
import { useSelection } from '@renderer/context/selection-context'
import { cn } from '@shared/lib/utils'

function NotificationItem({
  notification,
  onNavigate,
}: {
  notification: ApiNotification
  onNavigate: () => void
}) {
  const markRead = useMarkNotificationRead()
  const { selectAgent, selectSession } = useSelection()

  const handleClick = () => {
    selectAgent(notification.agentSlug)
    selectSession(notification.sessionId)
    if (!notification.isRead) {
      markRead.mutate(notification.id)
    }
    onNavigate()
  }

  const timeAgo = formatDistanceToNow(new Date(notification.createdAt), {
    addSuffix: true,
  })

  return (
    <button
      onClick={handleClick}
      className={cn(
        'w-full text-left px-3 py-2 hover:bg-accent transition-colors rounded-sm',
        !notification.isRead && 'bg-accent/50'
      )}
    >
      <div className="flex items-start gap-2">
        {!notification.isRead && (
          <span className="mt-1.5 h-2 w-2 rounded-full bg-blue-500 shrink-0" />
        )}
        <div className={cn('flex-1 min-w-0', notification.isRead && 'ml-4')}>
          <p className="text-sm font-medium truncate">{notification.title}</p>
          <p className="text-xs text-muted-foreground truncate">
            {notification.body}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">{timeAgo}</p>
        </div>
      </div>
    </button>
  )
}

export function NotificationBell() {
  const { data: notifications, isLoading } = useNotifications(20)
  const { data: countData } = useUnreadNotificationCount()
  const markAllRead = useMarkAllNotificationsRead()

  const unreadCount = countData?.count ?? 0

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="relative h-8 w-8 p-0">
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 rounded-full bg-red-500 text-[10px] font-medium text-white flex items-center justify-center">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
          <span className="sr-only">Notifications</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-0"
        align="end"
        side="top"
        sideOffset={8}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <h4 className="text-sm font-medium">Notifications</h4>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => markAllRead.mutate()}
              disabled={markAllRead.isPending}
            >
              <CheckCheck className="h-3 w-3 mr-1" />
              Mark all read
            </Button>
          )}
        </div>
        <ScrollArea className="h-[300px]">
          {isLoading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              Loading...
            </div>
          ) : !notifications?.length ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              <Bell className="h-8 w-8 mx-auto mb-2 opacity-20" />
              No notifications yet
            </div>
          ) : (
            <div className="py-1">
              {notifications.map((notification) => (
                <NotificationItem
                  key={notification.id}
                  notification={notification}
                  onNavigate={() => {
                    // Close popover by clicking outside or via state management
                  }}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
