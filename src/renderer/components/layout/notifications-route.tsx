import { useSidebar } from '@renderer/components/ui/sidebar'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { ErrorBoundary } from '@renderer/components/ui/error-boundary'
import { NotificationsView } from '@renderer/components/notifications/notifications-view'
import { ContentShell } from './content-shell'

/**
 * The global `/notifications` route. Split out of main-content.tsx in R4 so it is
 * its own top-level view (no agent slug), not a slug-less branch of the agent body.
 */
export function NotificationsRoute() {
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
        <NotificationsView />
      </ErrorBoundary>
    </ContentShell>
  )
}
