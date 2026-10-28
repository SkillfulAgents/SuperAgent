import { ExternalLink, Loader2, Megaphone } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { format } from 'date-fns'
import { useParams } from '@tanstack/react-router'
import { useNavigate } from '@tanstack/react-router'
import { buttonVariants } from '@renderer/components/ui/button'
import { MarkdownBlock } from '@renderer/components/messages/message-item'
import { markdownUrlTransform } from '@renderer/lib/markdown-url-transform'
import {
  usePlatformNotifications,
  useMarkPlatformNotificationsRead,
} from '@renderer/hooks/use-platform-notifications'
import { PageTitle, SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { useRenderTracker } from '@renderer/lib/perf'

/**
 * Detail view for one platform notification (`/notifications/$id`): title +
 * timestamp + markdown body, marked read on open. There is no by-id platform
 * endpoint — the row comes from the same live list read the inbox uses.
 */
export function PlatformNotificationDetail() {
  useRenderTracker('PlatformNotificationDetail')
  const { id } = useParams({ strict: false }) as { id?: string }
  const navigate = useNavigate()
  const { data, isLoading } = usePlatformNotifications(100)
  const markRead = useMarkPlatformNotificationsRead()

  const notification = data?.notifications.find((n) => n.id === id)

  // Mark read on open (write-through; once per mounted id)
  const markedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!notification || notification.read_at || markedRef.current === notification.id) return
    markedRef.current = notification.id
    markRead.mutate([notification.id])
  }, [notification, markRead])

  // action_url goes through the same URL-scheme allowlist as message links —
  // a disallowed scheme transforms to '' and the button simply doesn't render.
  // (The transform only reads url + key; the node param exists for the
  // react-markdown call site.)
  const transformHref = markdownUrlTransform as unknown as (
    url: string,
    key: string,
  ) => string | null | undefined
  const safeActionUrl = notification?.action_url
    ? (transformHref(notification.action_url, 'href') ?? '')
    : ''

  return (
    <SettingsPageContainer fullScreen>
      <PageTitle
        title={notification?.title ?? 'Notification'}
        back={{
          onClick: () => void navigate({ to: '/notifications' }),
          testId: 'platform-notification-back-button',
        }}
      />

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading notification...
        </div>
      ) : !notification ? (
        <div className="rounded-xl border border-dashed p-12 text-center text-sm text-muted-foreground">
          <Megaphone className="h-8 w-8 mx-auto mb-3 opacity-20" />
          Notification not found.
        </div>
      ) : (
        <div className="max-w-2xl" data-testid="platform-notification-detail">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-4">
            <Megaphone className="h-3.5 w-3.5" />
            <span>Platform</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">
              {format(new Date(notification.created_at), 'MMM d, yyyy h:mm a')}
            </span>
          </div>
          <div className="text-sm">
            <MarkdownBlock text={notification.body} />
          </div>
          {safeActionUrl && (
            <div className="mt-6">
              {/* Styled directly (buttonVariants) rather than `<Button asChild>` —
                  the Radix Slot trips React.Children.only (see route-fallbacks). */}
              <a
                href={safeActionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                Open link
              </a>
            </div>
          )}
        </div>
      )}
    </SettingsPageContainer>
  )
}
