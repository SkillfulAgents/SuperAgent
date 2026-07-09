import { useSidebar } from '@renderer/components/ui/sidebar'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { ErrorBoundary } from '@renderer/components/ui/error-boundary'
import { PlatformNotificationDetail } from '@renderer/components/notifications/platform-notification-detail'
import { ContentShell } from './content-shell'

/**
 * The `/notifications/$id` route: markdown detail view for one platform
 * notification, deep-linkable like the inbox itself.
 */
export function NotificationDetailRoute() {
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()
  const needsTrafficLightPadding =
    isElectron() && getPlatform() === 'darwin' && sidebarState === 'collapsed' && !isFullScreen

  return (
    <ContentShell
      needsTrafficLightPadding={needsTrafficLightPadding}
      headerContent={<span className="truncate text-sm font-light text-foreground">Notifications</span>}
    >
      <ErrorBoundary>
        <PlatformNotificationDetail />
      </ErrorBoundary>
    </ContentShell>
  )
}
