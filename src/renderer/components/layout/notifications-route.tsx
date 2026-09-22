import { useSidebar } from '@renderer/components/ui/sidebar'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { ErrorBoundary } from '@renderer/components/ui/error-boundary'
import { NotificationsView } from '@renderer/components/notifications/notifications-view'
import { ContentShell } from './content-shell'
import { ScrollAwareNavTitle } from './scroll-aware-title'

/**
 * The global `/notifications` route: its own top-level view (no agent slug),
 * not a slug-less branch of the agent body.
 */
export function NotificationsRoute() {
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()
  const needsTrafficLightPadding =
    isElectron() && getPlatform() === 'darwin' && sidebarState === 'collapsed' && !isFullScreen

  return (
    <ContentShell
      needsTrafficLightPadding={needsTrafficLightPadding}
      headerContent={
        <ScrollAwareNavTitle className="truncate text-sm font-light text-foreground">
          Notifications
        </ScrollAwareNavTitle>
      }
    >
      <ErrorBoundary>
        <NotificationsView />
      </ErrorBoundary>
    </ContentShell>
  )
}
