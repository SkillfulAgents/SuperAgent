import { useParams } from '@tanstack/react-router'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { ErrorBoundary } from '@renderer/components/ui/error-boundary'
import { TodoView } from '@renderer/components/todo/todo-view'
import { TodoItemHeader, TodoItemPage } from '@renderer/components/todo/todo-item-page'
import { ContentShell } from './content-shell'
import { ScrollAwareNavTitle } from './scroll-aware-title'

/**
 * The global `/todo` route: the kanban of work across every agent. A
 * prototype — the board lives in localStorage and agent activity is simulated.
 */
export function TodoRoute() {
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()
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
        <TodoView />
      </ErrorBoundary>
    </ContentShell>
  )
}


/**
 * `/todo/$itemId`: one item of work as a full page — back to the list in the
 * header, its session preview below.
 */
export function TodoItemRoute() {
  const { itemId } = useParams({ strict: false }) as { itemId?: string }
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()
  const needsTrafficLightPadding =
    isElectron() && getPlatform() === 'darwin' && sidebarState === 'collapsed' && !isFullScreen
  if (!itemId) return null

  return (
    <ContentShell needsTrafficLightPadding={needsTrafficLightPadding} headerContent={<TodoItemHeader itemId={itemId} />}>
      <ErrorBoundary>
        <TodoItemPage key={itemId} itemId={itemId} />
      </ErrorBoundary>
    </ContentShell>
  )
}
