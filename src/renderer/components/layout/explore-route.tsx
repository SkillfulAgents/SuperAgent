import { useParams } from '@tanstack/react-router'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { ErrorBoundary } from '@renderer/components/ui/error-boundary'
import { ExploreView } from '@renderer/components/explore/explore-view'
import { CategoryView } from '@renderer/components/explore/category-view'
import { TemplateDetailView } from '@renderer/components/explore/template-detail-view'
import { ContentShell } from './content-shell'

function useExploreShellProps() {
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()
  return {
    needsTrafficLightPadding:
      isElectron() && getPlatform() === 'darwin' && sidebarState === 'collapsed' && !isFullScreen,
    headerContent: (
      <span className="truncate text-sm font-light text-foreground">Discover New Agents</span>
    ),
  }
}

/** The global `/explore` route: the full-page agent template marketplace. */
export function ExploreRoute() {
  return (
    <ContentShell {...useExploreShellProps()}>
      <ErrorBoundary>
        <ExploreView />
      </ErrorBoundary>
    </ContentShell>
  )
}

/** The `/explore/$skillsetId/$templateSlug` route: one template's details page. */
export function ExploreTemplateRoute() {
  const params = useParams({ strict: false }) as { skillsetId?: string; templateSlug?: string }
  return (
    <ContentShell {...useExploreShellProps()}>
      <ErrorBoundary>
        {params.skillsetId && params.templateSlug && (
          <TemplateDetailView skillsetId={params.skillsetId} templateSlug={params.templateSlug} />
        )}
      </ErrorBoundary>
    </ContentShell>
  )
}

/** The `/explore/category/$category` route: every template in one category. */
export function ExploreCategoryRoute() {
  const params = useParams({ strict: false }) as { category?: string }
  return (
    <ContentShell {...useExploreShellProps()}>
      <ErrorBoundary>{params.category && <CategoryView category={params.category} />}</ErrorBoundary>
    </ContentShell>
  )
}
