import { useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { PageTitle, SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { slugFromAgentPath } from '@renderer/hooks/use-agent-templates'
import { ExploreTemplateCard } from './explore-template-card'
import { NoTemplatesEmptyState, useExploreTemplates } from './explore-templates'
import { FEATURED_SECTION_LABEL, isFeaturedTemplate, templateCategory } from './template-meta'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

/**
 * `/explore/category/$category` — every template in one category, reached from
 * a section's "Show N more" tile. `Featured` is a category here too, even
 * though it comes from the developer field rather than the category one.
 */
export function CategoryView({ category }: { category: string }) {
  const navigate = useNavigate()
  const { templates: all, hasSkillsets, isLoading } = useExploreTemplates()

  const templates = useMemo(
    () =>
      category === FEATURED_SECTION_LABEL
        ? all.filter(isFeaturedTemplate)
        : all.filter((t) => templateCategory(t) === category),
    [all, category],
  )

  const openTemplate = (template: ApiDiscoverableAgent) => {
    void navigate({
      to: '/explore/$skillsetId/$templateSlug',
      params: { skillsetId: template.skillsetId, templateSlug: slugFromAgentPath(template.path) },
    })
  }

  return (
    <SettingsPageContainer fullScreen className="px-[88px] pb-16 pt-12">
      <PageTitle
        title={
          <div className="flex items-baseline gap-2">
            <h2 className="text-xl font-medium">{category}</h2>
            {templates.length > 0 && (
              <span className="text-sm text-muted-foreground">{templates.length}</span>
            )}
          </div>
        }
        back={{ onClick: () => void navigate({ to: '/explore' }), label: 'Discover New Agents' }}
      />

      <div data-testid="explore-category-view">
        {isLoading ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-[180px] rounded-2xl" />
            ))}
          </div>
        ) : !hasSkillsets ? (
          <NoTemplatesEmptyState />
        ) : templates.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm text-muted-foreground">No templates in {category}.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void navigate({ to: '/explore' })}
            >
              Back to all agents
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {templates.map((template) => (
              <ExploreTemplateCard
                key={`${template.skillsetId}/${template.path}`}
                template={template}
                onOpen={openTemplate}
              />
            ))}
          </div>
        )}
      </div>
    </SettingsPageContainer>
  )
}
