import { useSidebar } from '@renderer/components/ui/sidebar'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { useExperiment } from '@renderer/hooks/use-experiment'
import { useUserSettings } from '@renderer/hooks/use-user-settings'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { ErrorBoundary } from '@renderer/components/ui/error-boundary'
import { AppLink } from '@renderer/components/ui/app-link'
import { TodoBoard } from '@renderer/components/todo/todo-board'
import { ContentShell } from './content-shell'
import { ScrollAwareNavTitle } from './scroll-aware-title'

/** Reached by URL with the experiment off: say where to turn it on. */
function TodoBoardOff() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 text-sm text-muted-foreground" data-testid="todo-board-off">
      <p>The Todo board is an experiment.</p>
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

/** The global `/todo` route: the Todo board (the `todo-board` experiment). */
export function TodoRoute() {
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()
  const enabled = useExperiment('todo-board')
  const { isPending: settingsPending } = useUserSettings()
  const needsTrafficLightPadding =
    isElectron() && getPlatform() === 'darwin' && sidebarState === 'collapsed' && !isFullScreen

  return (
    <ContentShell
      needsTrafficLightPadding={needsTrafficLightPadding}
      headerContent={
        <ScrollAwareNavTitle className="truncate text-sm font-light text-foreground">
          Todo
        </ScrollAwareNavTitle>
      }
    >
      <ErrorBoundary>
        {enabled ? <TodoBoard /> : !settingsPending && <TodoBoardOff />}
      </ErrorBoundary>
    </ContentShell>
  )
}
