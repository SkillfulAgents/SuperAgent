import { useMemo } from 'react'
import { Button } from '@renderer/components/ui/button'
import { useSkillsets } from '@renderer/hooks/use-skillsets'
import { useDiscoverableAgents } from '@renderer/hooks/use-agent-templates'
import { useDialogs } from '@renderer/context/dialog-context'
import { FEATURED_SECTION_LABEL, isFeaturedTemplate, templateCategory } from './template-meta'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

/**
 * The template roster for every Explore surface, with the one gate they all
 * need.
 *
 * `useDiscoverableAgents` is `enabled: hasSkillsets`, so with no skillset
 * configured it never runs: `isLoading` is false, `data` stays `undefined`
 * forever, and a page that branches on `data === undefined` renders a skeleton
 * that never resolves. Branch on `hasSkillsets` FIRST — that state is an empty
 * state, not a loading one.
 *
 * While the skillset list itself is still loading the answer is unknown, so
 * `hasSkillsets` optimistically reads true and `isLoading` covers the wait —
 * flashing "connect a skillset" at someone who has one is worse than a beat of
 * skeleton.
 */
export function useExploreTemplates(): {
  templates: ApiDiscoverableAgent[]
  hasSkillsets: boolean
  isLoading: boolean
} {
  const { data: skillsets } = useSkillsets()
  const { data: discoverableAgents, isLoading } = useDiscoverableAgents()

  const hasSkillsets = skillsets === undefined || skillsets.length > 0
  return {
    templates: useMemo(() => discoverableAgents ?? [], [discoverableAgents]),
    hasSkillsets,
    isLoading:
      skillsets === undefined || (hasSkillsets && (isLoading || discoverableAgents === undefined)),
  }
}

/** Shown wherever the roster is empty because nothing supplies templates. */
export function NoTemplatesEmptyState() {
  const { openSettings } = useDialogs()
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center" data-testid="explore-empty">
      <p className="text-sm text-muted-foreground">
        No agent templates available. Connect a skillset with agent templates to get started.
      </p>
      <Button type="button" variant="outline" size="sm" onClick={() => openSettings('skillsets')}>
        Manage skillsets
      </Button>
    </div>
  )
}

/** Bucket for templates whose skillset predates the category field. */
export const OTHER_CATEGORY = 'Other'

export interface TemplateSection {
  category: string
  /** The first `previewCount` templates — what a section shows up front. */
  shown: ApiDiscoverableAgent[]
  /** Everything past the preview, for a "show more" affordance. */
  rest: ApiDiscoverableAgent[]
}

/**
 * The roster split into the sections every browse surface shows: Featured
 * first, then the real categories most-populated first, each cut at
 * `previewCount`.
 *
 * A flat grid of 160+ templates buries everything past the first screen, so
 * both the Explore page and the wizard's create step group first — and they
 * have to group *identically*, or the same template sits under different
 * headings in two places. Shared here rather than duplicated for that reason.
 * `previewCount` splits each section into the `shown` cards and the `rest`
 * that waits behind a see-more affordance.
 *
 * First-party templates lead the page AND stay in their own category below:
 * they're the best of that category, not a separate kind of thing.
 */
export function groupTemplatesByCategory(
  templates: ApiDiscoverableAgent[],
  previewCount: number,
): TemplateSection[] {
  const byCategory = new Map<string, ApiDiscoverableAgent[]>()
  const featured: ApiDiscoverableAgent[] = []
  for (const t of templates) {
    if (isFeaturedTemplate(t)) featured.push(t)
    const c = templateCategory(t) ?? OTHER_CATEGORY
    const list = byCategory.get(c)
    if (list) list.push(t)
    else byCategory.set(c, [t])
  }
  const sections = [...byCategory.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([category, items]) => ({ category, items }))
  if (featured.length > 0) {
    sections.unshift({ category: FEATURED_SECTION_LABEL, items: featured })
  }
  return sections.map(({ category, items }) => ({
    category,
    shown: items.slice(0, previewCount),
    rest: items.slice(previewCount),
  }))
}
