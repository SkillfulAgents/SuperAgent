import { useSidebar } from '@renderer/components/ui/sidebar'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { useExperiment } from '@renderer/hooks/use-experiment'
import { useUserSettings } from '@renderer/hooks/use-user-settings'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { ErrorBoundary } from '@renderer/components/ui/error-boundary'
import { AppLink } from '@renderer/components/ui/app-link'
import { TeamBrainPage } from '@renderer/components/team-brain/team-brain-page'
import { ContentShell } from './content-shell'
import { ScrollAwareNavTitle } from './scroll-aware-title'

/** Reached by URL with the experiment off: say where to turn it on. */
function TeamBrainOff() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 text-sm text-muted-foreground" data-testid="team-brain-off">
      <p>Team Brain is an experiment.</p>
      <p>
        Turn it on in{' '}
        <AppLink to="/settings/$tab" params={{ tab: 'experiments' }} className="text-foreground underline underline-offset-2">
          Settings → Experiments
        </AppLink>
        .
      </p>
    </div>
  )
}

/** The global `/team-brain` route (the `team-brain` experiment). */
export function TeamBrainRoute() {
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()
  const enabled = useExperiment('team-brain')
  const { isPending: settingsPending } = useUserSettings()
  const needsTrafficLightPadding =
    isElectron() && getPlatform() === 'darwin' && sidebarState === 'collapsed' && !isFullScreen

  return (
    <ContentShell
      needsTrafficLightPadding={needsTrafficLightPadding}
      headerContent={
        <ScrollAwareNavTitle className="truncate text-sm font-light text-foreground">
          Team Brain
        </ScrollAwareNavTitle>
      }
    >
      <ErrorBoundary>
        {enabled ? <TeamBrainPage /> : !settingsPending && <TeamBrainOff />}
      </ErrorBoundary>
    </ContentShell>
  )
}
