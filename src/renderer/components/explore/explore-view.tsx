import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Check, Filter, Search, SlidersHorizontal } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { PageTitle, SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { useSkillsets } from '@renderer/hooks/use-skillsets'
import { useDiscoverableAgents, slugFromAgentPath } from '@renderer/hooks/use-agent-templates'
import { useDialogs } from '@renderer/context/dialog-context'
import { ExploreTemplateCard } from './explore-template-card'
import { templateCategory } from './template-meta'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

/**
 * The full-page agent template marketplace behind the sidebar's Explore item.
 * Same data source as the browse dialog (`useDiscoverableAgents`); the
 * category filter offers the real categories declared by the skillset index.
 * Cards open `/explore/$skillsetId/$templateSlug`, which is where installing
 * happens.
 */
export function ExploreView() {
  const navigate = useNavigate()
  const { openSettings } = useDialogs()
  const { data: skillsets } = useSkillsets()
  const { data: discoverableAgents, isLoading } = useDiscoverableAgents()

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  // `null` means "no category filter"; a set means only those are shown.
  const [selectedCategories, setSelectedCategories] = useState<Set<string> | null>(null)
  const [selectedSkillsets, setSelectedSkillsets] = useState<Set<string> | null>(null)

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 150)
    return () => clearTimeout(id)
  }, [search])

  const templates = useMemo(() => discoverableAgents ?? [], [discoverableAgents])

  // The categories this roster actually declares, with counts — most populated
  // first so the long tail of one-off categories sorts last.
  const categories = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of templates) {
      const c = templateCategory(t)
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }))
  }, [templates])

  const skillsetList = useMemo(() => {
    const seen = new Map<string, string>()
    for (const t of templates) {
      if (!seen.has(t.skillsetId)) seen.set(t.skillsetId, t.skillsetName)
    }
    return Array.from(seen, ([id, name]) => ({ id, name }))
  }, [templates])

  const activeSkillsets = useMemo(
    () => selectedSkillsets ?? new Set(skillsetList.map((s) => s.id)),
    [selectedSkillsets, skillsetList],
  )

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase()
    return templates.filter((t) => {
      if (!activeSkillsets.has(t.skillsetId)) return false
      if (selectedCategories) {
        const c = templateCategory(t)
        if (!c || !selectedCategories.has(c)) return false
      }
      if (!q) return true
      return (
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        (t.tags?.some((tag) => tag.toLowerCase().includes(q)) ?? false)
      )
    })
  }, [templates, debouncedSearch, selectedCategories, activeSkillsets])

  const openTemplate = (template: ApiDiscoverableAgent) => {
    void navigate({
      to: '/explore/$skillsetId/$templateSlug',
      params: { skillsetId: template.skillsetId, templateSlug: slugFromAgentPath(template.path) },
    })
  }

  const hasSkillsets = skillsets === undefined || skillsets.length > 0
  const showSkeleton = skillsets === undefined || (hasSkillsets && isLoading)

  return (
    <SettingsPageContainer fullScreen className="px-[88px]">
      <PageTitle title="Discover New Agents" />

      <div className="space-y-4" data-testid="explore-view">
        <div className="flex flex-wrap items-center gap-2">
          {categories.length > 1 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" className="h-9 gap-2">
                  <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
                  Category
                  {selectedCategories && selectedCategories.size > 0 && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
                      {selectedCategories.size}
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-56 p-1 space-y-0.5">
                {categories.map(({ name, count }) => {
                  const checked = selectedCategories?.has(name) ?? false
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => {
                        const next = new Set(selectedCategories ?? [])
                        if (checked) next.delete(name)
                        else next.add(name)
                        // Empty set === no filter, so the list never goes blank.
                        setSelectedCategories(next.size === 0 ? null : next)
                      }}
                      className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent ${
                        checked ? 'bg-accent' : ''
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate text-xs">{name}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{count}</span>
                      {checked && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
                    </button>
                  )
                })}
                {selectedCategories && (
                  <button
                    type="button"
                    onClick={() => setSelectedCategories(null)}
                    className="mt-0.5 flex w-full items-center rounded-sm border-t px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    Clear
                  </button>
                )}
              </PopoverContent>
            </Popover>
          )}

          {/* Search sits at the far right; `ml-auto` pushes it and the skillset
              filter away from the category chips on the left. */}
          <div className="relative ml-auto w-56">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search templates..."
              className="pl-8"
            />
          </div>

          {skillsetList.length > 1 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-9 w-9 relative"
                  title="Filter by skillset"
                  aria-label="Filter by skillset"
                >
                  <Filter className="h-4 w-4 text-muted-foreground" />
                  {selectedSkillsets && selectedSkillsets.size < skillsetList.length && (
                    <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary" />
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56 p-1 space-y-0.5">
                {skillsetList.map((ss) => {
                  const checked = activeSkillsets.has(ss.id)
                  return (
                    <button
                      key={ss.id}
                      type="button"
                      onClick={() => {
                        const next = new Set(activeSkillsets)
                        if (checked) next.delete(ss.id)
                        else next.add(ss.id)
                        setSelectedSkillsets(next.size === skillsetList.length ? null : next)
                      }}
                      className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent ${
                        checked ? 'bg-accent' : ''
                      }`}
                    >
                      <span className="text-xs truncate flex-1 min-w-0">{ss.name}</span>
                      {checked && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
                    </button>
                  )
                })}
              </PopoverContent>
            </Popover>
          )}
        </div>

        {showSkeleton ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-40 rounded-2xl" />
            ))}
          </div>
        ) : !hasSkillsets || templates.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm text-muted-foreground">
              No agent templates available. Connect a skillset with agent templates to get started.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => openSettings('skillsets')}>
              Manage skillsets
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {debouncedSearch.trim()
              ? `No templates matching "${debouncedSearch}"`
              : 'No templates in this category'}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {filtered.map((template) => (
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

