import { useCallback, useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowDownToLine } from 'lucide-react'
import { Skeleton } from '@renderer/components/ui/skeleton'
import {
  ExploreTemplateCard,
  SeeMoreCard,
} from '@renderer/components/explore/explore-template-card'
import {
  groupTemplatesByCategory,
  useExploreTemplates,
} from '@renderer/components/explore/explore-templates'
import { useIsMobile } from '@renderer/hooks/use-mobile'
import { captureRendererException } from '@renderer/lib/error-reporting'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

/**
 * Template cards shown per category section; the see-more tile takes the next
 * slot, so a section always ends on a full row. Desktop is a 3x2 grid (five
 * cards + the tile); mobile is a single column, where six full-width cards
 * per category would bury the next heading — three plus the tile keeps every
 * category within a couple of swipes. Both counts pair with the grid's
 * `md:` breakpoint, which is the same 768px line `useIsMobile` watches.
 */
const SECTION_PREVIEW_COUNT = 5
const MOBILE_SECTION_PREVIEW_COUNT = 3

/**
 * The Explore roster, inlined under the create-agent composer.
 *
 * Same data, same cards, same grouping as `/explore` — but this renders inside
 * the onboarding wizard, which is a full-screen overlay mounted ABOVE the
 * router. A card hands its template back to the caller, which installs it in
 * place through `TemplateInstallDialog`. The see-more tile (shared with
 * Explore) opens the same category page it does there — which means leaving
 * the wizard, so it awaits `onNavigateAway` first and the wizard finishes
 * itself before the router moves.
 *
 * Each category is a six-slot 3x2 section — five cards plus the see-more tile
 * — and the sections stack vertically. The caller owns the scrolling: the
 * wizard pins the composer and scrolls this component underneath it, so the
 * main event stays put while the roster runs as deep as it needs to.
 *
 * Renders nothing at all when the roster is empty. There is no "connect a
 * skillset" empty state here on purpose — the composer above is a complete way
 * to create an agent, and a first-run user with no skillsets should see a
 * clean page rather than a dead end for a feature they never asked for.
 */
export function CreateAgentTemplates({
  onSelect,
  onNavigateAway,
  onImportClick,
  className,
}: {
  onSelect: (template: ApiDiscoverableAgent) => void
  /**
   * Awaited before the see-more tile leaves for the Explore category page.
   * The wizard hosts this in a full-screen overlay ABOVE the router, so it
   * has to finish itself first or the user navigates to a page they can't
   * see.
   */
  onNavigateAway?: () => void | Promise<void>
  /**
   * Renders the "Import an Agent" tile after the last section, opening the
   * caller's import dialog. Omitted → no tile.
   */
  onImportClick?: () => void
  className?: string
}) {
  const navigate = useNavigate()
  const { templates, isLoading } = useExploreTemplates()
  const isMobile = useIsMobile()

  const openCategory = useCallback(
    async (category: string) => {
      // Same contract as the old Browse Templates aid: the hook can reject
      // (the wizard's is a settings PUT that carries `skipGlobalErrorToast`,
      // so a failure is otherwise silent). Leave for the category page either
      // way — a click that does nothing at all is the worse outcome, and the
      // host staying open is its own visible signal.
      try {
        await onNavigateAway?.()
      } catch (error) {
        console.error('[create-agent] navigate-away hook failed:', error)
        captureRendererException(error, {
          tags: { area: 'create-agent', op: 'see-more-templates' },
        })
      }
      void navigate({ to: '/explore/category/$category', params: { category } })
    },
    [onNavigateAway, navigate],
  )

  // No search here on purpose: the sections are a browsing teaser, and
  // Explore — one see-more click away — already owns search and filtering. A
  // second, smaller search box beside the composer also competes with it for
  // "the place you type".
  const previewCount = isMobile ? MOBILE_SECTION_PREVIEW_COUNT : SECTION_PREVIEW_COUNT
  const grouped = useMemo(
    () => groupTemplatesByCategory(templates, previewCount),
    [templates, previewCount],
  )

  if (isLoading) {
    return (
      <div className={className} data-testid="create-agent-templates-loading">
        <SectionHeading>Or start from a template</SectionHeading>
        <TemplateGrid>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[180px] rounded-2xl" />
          ))}
        </TemplateGrid>
      </div>
    )
  }

  if (templates.length === 0) return null

  return (
    <div className={className} data-testid="create-agent-templates">
      <SectionHeading>Or start from a template</SectionHeading>
      <div className="space-y-8">
        {grouped.map(({ category, shown, rest }) => (
          <section key={category}>
            <h4 className="mb-2 text-[13px] font-medium text-muted-foreground">{category}</h4>
            <TemplateGrid>
              {shown.map((template) => (
                <ExploreTemplateCard
                  key={`${template.skillsetId}/${template.path}`}
                  template={template}
                  onOpen={onSelect}
                />
              ))}
              {rest.length > 0 && (
                <SeeMoreCard rest={rest} onClick={() => void openCategory(category)} />
              )}
            </TemplateGrid>
          </section>
        ))}
        {onImportClick && <ImportTile onClick={onImportClick} />}
      </div>
    </div>
  )
}

/**
 * The list's last row: bring-your-own-agent. Full width and deliberately not
 * card-shaped — it's an offer, not a template.
 */
function ImportTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="import-agent-card"
      onClick={onClick}
      className="flex h-[100px] w-full flex-col items-center justify-center gap-2 rounded-2xl bg-muted/50 p-4 transition-colors duration-200 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="grid size-9 place-items-center rounded-xl bg-card shadow-[0_1px_2px_0_rgba(0,0,0,0.06)]">
        <ArrowDownToLine className="size-4 text-muted-foreground" aria-hidden />
      </span>
      <span className="text-[13px] font-medium text-foreground">Import an Agent</span>
    </button>
  )
}

/** Same size as the step's "Describe your first AI teammate" title, but in
 *  the muted color — the roster is the alternative path, one register below
 *  the question it answers. */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-6 text-2xl font-normal text-muted-foreground">{children}</h3>
}

/** Three fluid columns on desktop, one on phones; the see-more tile fills
 *  the slot after the last card either way. */
function TemplateGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 md:grid-cols-3">{children}</div>
}
