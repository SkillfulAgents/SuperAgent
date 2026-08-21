import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Check, Filter, Plus, Search, Settings2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { PageTitle, SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { slugFromAgentPath } from '@renderer/hooks/use-agent-templates'
import { ExploreTemplateCard } from './explore-template-card'
import { NoTemplatesEmptyState, useExploreTemplates } from './explore-templates'
import {
  getRememberedExploreScrollPosition,
  rememberExploreScrollPosition,
} from './explore-scroll-restoration'
import {
  connectionLabel,
  FEATURED_SECTION_LABEL,
  getTemplateAccent,
  getTemplateIcon,
  isFeaturedTemplate,
  templateCategory,
} from './template-meta'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

/** Cards shown per category. The "see more" tile takes the sixth slot, so a
 *  full section is three even grid rows at the two-column breakpoint. */
const SECTION_PREVIEW_COUNT = 5

/** Templates named on the see-more tile before the "+ N more" line. */
const SEE_MORE_NAMED_COUNT = 3

/** Bucket for templates whose skillset predates the category field. */
const OTHER_CATEGORY = 'Other'

/**
 * The full-page agent template marketplace behind the sidebar's Explore item.
 * Same data source as the browse dialog (`useDiscoverableAgents`); the
 * category filter offers the real categories declared by the skillset index.
 * Cards open `/explore/$skillsetId/$templateSlug`, which is where installing
 * happens.
 */
export function ExploreView() {
  const navigate = useNavigate()
  const historyEntryKey = useLocation({
    select: (location) => location.state.__TSR_key ?? location.href,
  })
  const { templates, hasSkillsets, isLoading } = useExploreTemplates()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const restoredEntryRef = useRef<string | null>(null)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  // `null` means "no filter"; a set means only those are shown.
  const [selectedCategories, setSelectedCategories] = useState<Set<string> | null>(null)
  const [selectedConnections, setSelectedConnections] = useState<Set<string> | null>(null)
  const [selectedSkillsets, setSelectedSkillsets] = useState<Set<string> | null>(null)

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 150)
    return () => clearTimeout(id)
  }, [search])

  // This page scrolls a nested container, not `window`, so the browser cannot
  // restore it when the route remounts. Restore only after the cached roster is
  // back in the DOM, before paint, and only once for this history entry.
  useLayoutEffect(() => {
    if (isLoading || restoredEntryRef.current === historyEntryKey) return

    const scrollTop = getRememberedExploreScrollPosition(historyEntryKey)
    if (scrollTop !== undefined && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollTop
    }
    restoredEntryRef.current = historyEntryKey
  }, [historyEntryKey, isLoading])

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

  // Every service the roster connects to, most common first.
  const connections = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of templates) {
      // A template listing the same service twice shouldn't double-count it.
      for (const slug of new Set((t.worksWith ?? []).map((c) => c.slug))) {
        counts.set(slug, (counts.get(slug) ?? 0) + 1)
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || connectionLabel(a[0]).localeCompare(connectionLabel(b[0])))
      .map(([slug, count]) => ({ slug, count }))
  }, [templates])

  const filterCount = (selectedCategories?.size ?? 0) + (selectedConnections?.size ?? 0)

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
      // Compatibility is an OR within itself: pick Slack and Gmail to see
      // everything touching either, not only templates using both.
      if (selectedConnections) {
        const slugs = t.worksWith ?? []
        if (!slugs.some((c) => selectedConnections.has(c.slug))) return false
      }
      if (!q) return true
      return (
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        (t.tags?.some((tag) => tag.toLowerCase().includes(q)) ?? false)
      )
    })
  }, [templates, debouncedSearch, selectedCategories, selectedConnections, activeSkillsets])

  /**
   * With no search or filter on, the roster is 160+ templates — a flat grid
   * buries everything past the first screen. Group into category sections and
   * show only the first few of each, with a row that filters to the rest. Any
   * active search or filter means the user is already narrowing, so the flat
   * grid of results is what they want.
   */
  const isBrowsing = !debouncedSearch.trim() && filterCount === 0
  const grouped = useMemo(() => {
    if (!isBrowsing) return null
    const byCategory = new Map<string, ApiDiscoverableAgent[]>()
    const featured: ApiDiscoverableAgent[] = []
    for (const t of filtered) {
      // First-party templates lead the page, and stay in their category below
      // — they're the best of that category, not a separate kind of thing.
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
      shown: items.slice(0, SECTION_PREVIEW_COUNT),
      rest: items.slice(SECTION_PREVIEW_COUNT),
    }))
  }, [filtered, isBrowsing])

  const openTemplate = (template: ApiDiscoverableAgent) => {
    rememberExploreScrollPosition(historyEntryKey, scrollContainerRef.current?.scrollTop ?? 0)
    void navigate({
      to: '/explore/$skillsetId/$templateSlug',
      params: { skillsetId: template.skillsetId, templateSlug: slugFromAgentPath(template.path) },
      state: { exploreReturnKey: historyEntryKey },
    })
  }

  return (
    // `pt-12` rather than `fullScreen`'s `pt-4`: the notifications page sits a
    // back button above its heading, and this page has none — without the extra
    // lead-in the title crowds the header border.
    <SettingsPageContainer
      fullScreen
      scrollContainerRef={scrollContainerRef}
      scrollRestorationId="explore-marketplace"
      className="px-[88px] pb-16 pt-12"
    >
      <PageTitle
        title="Discover New Agents"
        scrollAware
        actions={
          <div className="flex items-center gap-2">
              <div className="relative w-56">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search templates..."
                  className="pl-8"
                />
              </div>

              {(categories.length > 1 || connections.length > 1) && (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 gap-2 px-3"
                      title="Filter"
                      aria-label="Filter"
                    >
                      <Settings2 className="h-4 w-4 text-muted-foreground" />
                      {filterCount > 0 && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
                          {filterCount}
                        </span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-64 p-0">
                    {/* Compatibility can run to ~30 services, so the body scrolls
                        and the Clear footer stays pinned below it. */}
                    <div className="max-h-[340px] overflow-y-auto p-1">
                      {categories.length > 1 && (
                        <>
                          <FilterSectionLabel>Category</FilterSectionLabel>
                          {categories.map(({ name, count }) => (
                            <FilterRow
                              key={name}
                              label={name}
                              count={count}
                              checked={selectedCategories?.has(name) ?? false}
                              onToggle={() => toggleIn(selectedCategories, name, setSelectedCategories)}
                            />
                          ))}
                        </>
                      )}

                      {connections.length > 1 && (
                        <>
                          <FilterSectionLabel className={categories.length > 1 ? 'mt-2' : undefined}>
                            Compatibility
                          </FilterSectionLabel>
                          {connections.map(({ slug, count }) => (
                            <FilterRow
                              key={slug}
                              label={connectionLabel(slug)}
                              count={count}
                              checked={selectedConnections?.has(slug) ?? false}
                              onToggle={() => toggleIn(selectedConnections, slug, setSelectedConnections)}
                              icon={<ServiceIcon slug={slug} className="size-3.5 shrink-0" />}
                            />
                          ))}
                        </>
                      )}
                    </div>

                    {filterCount > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedCategories(null)
                          setSelectedConnections(null)
                        }}
                        className="flex w-full items-center border-t px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        Clear filters
                      </button>
                    )}
                  </PopoverContent>
                </Popover>
              )}

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
                            // Same rule as `toggleIn`: all checked and none
                            // checked both mean "no filter". Letting the set
                            // empty out would strand the page on zero results
                            // with no filter chip explaining why.
                            setSelectedSkillsets(
                              next.size === 0 || next.size === skillsetList.length ? null : next,
                            )
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
        }
      />

      {/* `pt-*`, not `mt-*`: the container's `space-y-6` sets margin-top via a
          descendant selector that outranks a margin utility here, so a margin
          would be silently ignored. */}
      <div className="space-y-4 pt-6" data-testid="explore-view">
        {isLoading ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-40 rounded-2xl" />
            ))}
          </div>
        ) : !hasSkillsets || templates.length === 0 ? (
          <NoTemplatesEmptyState />
        ) : filtered.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {debouncedSearch.trim()
              ? `No templates matching "${debouncedSearch}"`
              : 'No templates match these filters'}
          </p>
        ) : grouped ? (
          <div className="space-y-10">
            {grouped.map(({ category, shown, rest }) => (
              <section key={category}>
                <h3 className="mb-3 text-sm font-medium text-foreground">{category}</h3>
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {shown.map((template) => (
                    <ExploreTemplateCard
                      key={`${template.skillsetId}/${template.path}`}
                      template={template}
                      onOpen={openTemplate}
                    />
                  ))}
                  {rest.length > 0 && (
                    <SeeMoreCard
                      rest={rest}
                      onClick={() =>
                        void navigate({ to: '/explore/category/$category', params: { category } })
                      }
                    />
                  )}
                </div>
              </section>
            ))}
          </div>
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


/** Add or remove one value from a filter set. An empty set collapses back to
 *  `null` — "nothing checked" must mean "no filter", not "match nothing". */
function toggleIn(
  current: Set<string> | null,
  value: string,
  set: (next: Set<string> | null) => void,
) {
  const next = new Set(current ?? [])
  if (next.has(value)) next.delete(value)
  else next.add(value)
  set(next.size === 0 ? null : next)
}

function FilterSectionLabel({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={`px-2 pb-1 pt-1.5 text-xs text-muted-foreground/60 ${className ?? ''}`}>
      {children}
    </div>
  )
}

function FilterRow({
  label,
  count,
  checked,
  onToggle,
  icon,
}: {
  label: string
  count: number
  checked: boolean
  onToggle: () => void
  icon?: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={checked}
      className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent ${
        checked ? 'bg-accent' : ''
      }`}
    >
      {icon}
      <span className="min-w-0 truncate text-sm">{label}</span>
      <span className="shrink-0 text-xs text-muted-foreground/60">{count}</span>
      {checked && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-foreground" />}
    </button>
  )
}

/**
 * The section's sixth grid slot: a few of the hidden templates by name over a
 * call to action. Clicking anywhere opens that category's page.
 *
 * The call to action is unconditional — the tile is only ever a link, so one
 * without it reads as a card that failed to render. Only the "+ N" count is
 * conditional, since a section hiding no more than it names has no remainder
 * to count (Featured, at eight templates, is exactly that case).
 */
function SeeMoreCard({ rest, onClick }: { rest: ApiDiscoverableAgent[]; onClick: () => void }) {
  const unnamed = rest.length - Math.min(rest.length, SEE_MORE_NAMED_COUNT)
  return (
    <button
      type="button"
      data-testid="explore-see-more"
      onClick={onClick}
      className="group flex h-[180px] w-full flex-col gap-3 rounded-2xl bg-muted/50 p-4 text-left transition-colors duration-200 hover:bg-muted"
    >
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-2">
        {rest.slice(0, SEE_MORE_NAMED_COUNT).map((template) => {
          const Icon = getTemplateIcon(template)
          return (
            <span
              key={`${template.skillsetId}/${template.path}`}
              className="flex min-w-0 items-center gap-2"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-card shadow-[0_1px_2px_0_rgba(0,0,0,0.06)]">
                <Icon className={`size-4 ${getTemplateAccent(template.name)}`} aria-hidden />
              </span>
              <span className="truncate text-[13px] text-muted-foreground">{template.name}</span>
            </span>
          )
        })}
        {/* The glyph sits in the same column as the icons above, so the label
            lines up with the names. */}
        <span className="flex min-w-0 items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-card shadow-[0_1px_2px_0_rgba(0,0,0,0.06)]">
            {unnamed > 0 ? (
              <Plus className="size-4 text-muted-foreground/50" aria-hidden />
            ) : (
              <ArrowRight
                className="size-4 text-muted-foreground/50 transition-transform duration-200 group-hover:translate-x-0.5"
                aria-hidden
              />
            )}
          </span>
          <span className="flex min-w-0 items-center gap-1 truncate text-[13px] text-muted-foreground/70">
            {unnamed > 0 ? `Show ${unnamed} more` : 'See all'}
            {unnamed > 0 && (
              <ArrowRight
                className="size-3.5 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5"
                aria-hidden
              />
            )}
          </span>
        </span>
      </span>

    </button>
  )
}
