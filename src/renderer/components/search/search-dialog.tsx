import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import {
  Bot,
  ChevronRight,
  CornerDownLeft,
  LayoutDashboard,
  MessageSquare,
  Search,
  SearchX,
} from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { HighlightMatch } from '@renderer/components/ui/highlight-match'
import { useAgents } from '@renderer/hooks/use-agents'
import { useSearch } from '@renderer/context/search-context'
import { useIsMobile } from '@renderer/hooks/use-mobile'
import { useNavigate } from '@tanstack/react-router'
import { apiFetch } from '@renderer/lib/api'
import type { ApiSession } from '@shared/lib/types/api'
import { cn } from '@shared/lib/utils/cn'
import { formatDistanceToNow } from 'date-fns'
import { filterAgentsAndSessions, flattenGroups, getRecentAgents, type FlatItem } from './filter'

function formatLastRun(date: Date | string | null | undefined): string | null {
  if (!date) return null
  return `Last run ${formatDistanceToNow(new Date(date), { addSuffix: true })}`
}

type IndicatorValues = {
  top: number
  left: number
  width: number
  height: number
}

type IndicatorMotion = {
  current: IndicatorValues
  target: IndicatorValues
  velocity: IndicatorValues
  initialized: boolean
  frame: number | null
  lastTime: number
}

const ZERO_INDICATOR_VALUES: IndicatorValues = { top: 0, left: 0, width: 0, height: 0 }
const INDICATOR_STIFFNESS = 500
const INDICATOR_DAMPING = 32

function SearchSelectionIndicator({
  activeIndex,
  items,
  listRef,
  open,
}: {
  activeIndex: number
  items: readonly FlatItem[]
  listRef: React.RefObject<HTMLDivElement | null>
  open: boolean
}) {
  const indicatorRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef<IndicatorMotion>({
    current: { ...ZERO_INDICATOR_VALUES },
    target: { ...ZERO_INDICATOR_VALUES },
    velocity: { ...ZERO_INDICATOR_VALUES },
    initialized: false,
    frame: null,
    lastTime: 0,
  })

  const renderValues = useCallback((values: IndicatorValues) => {
    const indicator = indicatorRef.current
    if (!indicator) return
    indicator.style.width = `${values.width}px`
    indicator.style.height = `${values.height}px`
    indicator.style.transform = `translate3d(${values.left}px, ${values.top}px, 0)`
  }, [])

  const stopAnimation = useCallback(() => {
    const motion = motionRef.current
    if (motion.frame !== null) cancelAnimationFrame(motion.frame)
    motion.frame = null
    motion.lastTime = 0
  }, [])

  const animate = useCallback(() => {
    const motion = motionRef.current
    if (motion.frame !== null) return

    const step = (time: number) => {
      const state = motionRef.current
      const dt = state.lastTime === 0 ? 1 / 60 : Math.min((time - state.lastTime) / 1000, 1 / 30)
      state.lastTime = time

      let settled = true
      for (const key of ['top', 'left', 'width', 'height'] as const) {
        const displacement = state.target[key] - state.current[key]
        const acceleration = INDICATOR_STIFFNESS * displacement - INDICATOR_DAMPING * state.velocity[key]
        state.velocity[key] += acceleration * dt
        state.current[key] += state.velocity[key] * dt
        if (Math.abs(displacement) > 0.1 || Math.abs(state.velocity[key]) > 0.1) settled = false
      }

      if (settled) {
        state.current = { ...state.target }
        state.velocity = { ...ZERO_INDICATOR_VALUES }
        state.frame = null
        state.lastTime = 0
        renderValues(state.current)
        return
      }

      renderValues(state.current)
      state.frame = requestAnimationFrame(step)
    }

    motion.frame = requestAnimationFrame(step)
  }, [renderValues])

  const measure = useCallback(() => {
    const list = listRef.current
    const indicator = indicatorRef.current
    const row = list?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    if (!list || !indicator || !row || !open) {
      if (indicator) indicator.style.opacity = '0'
      return
    }

    row.scrollIntoView({ block: 'nearest' })
    const listRect = list.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const target = {
      top: rowRect.top - listRect.top + list.scrollTop,
      left: rowRect.left - listRect.left + list.scrollLeft,
      width: rowRect.width,
      height: rowRect.height,
    }
    const motion = motionRef.current
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

    indicator.style.opacity = '1'
    motion.target = target
    if (!motion.initialized || reduceMotion) {
      stopAnimation()
      motion.current = { ...target }
      motion.velocity = { ...ZERO_INDICATOR_VALUES }
      motion.initialized = true
      renderValues(target)
      return
    }

    animate()
  }, [activeIndex, animate, listRef, open, renderValues, stopAnimation])

  useLayoutEffect(() => {
    if (!open) {
      stopAnimation()
      motionRef.current.initialized = false
      if (indicatorRef.current) indicatorRef.current.style.opacity = '0'
      return
    }

    measure()
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (list) observer?.observe(list)
    if (row) observer?.observe(row)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [activeIndex, items, listRef, measure, open, stopAnimation])

  useEffect(() => stopAnimation, [stopAnimation])

  return (
    <div
      ref={indicatorRef}
      aria-hidden="true"
      data-testid="search-selection-indicator"
      className="pointer-events-none absolute left-0 top-0 z-0 rounded-xl bg-accent opacity-0 ring-1 ring-inset ring-border/50 will-change-transform motion-reduce:transition-none"
    />
  )
}

/**
 * Rendered inside the router, so it can use the `useNavigate` hook directly.
 * Open state comes from SearchContext (`open`/`closeSearch`), which lives above
 * the router.
 */
export function SearchDialog() {
  const { open, closeSearch } = useSearch()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [expandedSlugs, setExpandedSlugs] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()
  const { data: agents } = useAgents()

  const sessionQueries = useQueries({
    queries: (agents ?? []).map((a) => ({
      queryKey: ['sessions', a.slug],
      queryFn: async () => {
        const res = await apiFetch(`/api/agents/${a.slug}/sessions`)
        if (!res.ok) throw new Error('Failed to fetch sessions')
        return res.json() as Promise<ApiSession[]>
      },
      enabled: open,
      staleTime: 30_000,
    })),
  })

  // Reset state on open
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      setExpandedSlugs(new Set())
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // On mobile, dismissing the soft keyboard (the keyboard's "down" button, or a
  // tap outside the field) is a natural "done searching" gesture — close the
  // overlay. iOS has no keyboard event, but the VisualViewport shrinks while the
  // keyboard is up and returns to full height once it's dismissed; we close on
  // that shown→hidden transition. Tapping a result keeps the keyboard up (it
  // doesn't blur the input), so this won't pre-empt selection.
  useEffect(() => {
    const vv = window.visualViewport
    if (!open || !isMobile || !vv) return
    let keyboardWasShown = false
    const onResize = () => {
      const occluded = window.innerHeight - vv.height
      if (occluded > 120) {
        keyboardWasShown = true
      } else if (keyboardWasShown) {
        closeSearch()
      }
    }
    vv.addEventListener('resize', onResize)
    return () => vv.removeEventListener('resize', onResize)
  }, [open, isMobile, closeSearch])

  const sessionsByAgent = useMemo(() => {
    if (!agents) return {}
    const map: Record<string, ApiSession[]> = {}
    agents.forEach((a, i) => {
      map[a.slug] = sessionQueries[i]?.data ?? []
    })
    return map
  }, [agents, sessionQueries])

  const isSearchMode = query.trim().length > 0
  const normalizedQuery = query.trim()

  const visibleGroups = useMemo(() => {
    if (!agents) return []
    if (isSearchMode) {
      return filterAgentsAndSessions(agents, sessionsByAgent, query)
    }
    return getRecentAgents(agents, sessionsByAgent)
  }, [agents, sessionsByAgent, query, isSearchMode])

  const flatItems = useMemo<FlatItem[]>(() => {
    if (isSearchMode) {
      return flattenGroups(visibleGroups)
    }
    return flattenGroups(visibleGroups, expandedSlugs)
  }, [visibleGroups, isSearchMode, expandedSlugs])

  // Clamp activeIndex when result list shrinks
  useEffect(() => {
    setActiveIndex((idx) =>
      flatItems.length === 0 ? 0 : Math.min(idx, flatItems.length - 1)
    )
  }, [flatItems.length])

  // Keep the active item visible as the user navigates
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const toggleExpand = (slug: string) => {
    setExpandedSlugs((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) {
        next.delete(slug)
      } else {
        next.add(slug)
      }
      return next
    })
  }

  const handleSelect = (item: FlatItem) => {
    // Close the dialog BEFORE navigating: the route transition otherwise strands
    // the Radix overlay open (it intercepts pointer events on the page beneath).
    closeSearch()
    if (item.kind === 'agent') {
      void navigate({ to: '/agents/$slug', params: { slug: item.agent.slug } })
    } else if (item.kind === 'dashboard') {
      void navigate({
        to: '/agents/$slug/dashboards/$dashSlug',
        params: { slug: item.agent.slug, dashSlug: item.dashboard.slug },
      })
    } else {
      void navigate({
        to: '/agents/$slug/sessions/$sessionId',
        params: { slug: item.agent.slug, sessionId: item.session.id },
      })
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (flatItems.length === 0 ? 0 : (i + 1) % flatItems.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) =>
        flatItems.length === 0 ? 0 : (i - 1 + flatItems.length) % flatItems.length
      )
    } else if (e.key === 'ArrowRight' && !isSearchMode) {
      e.preventDefault()
      const item = flatItems[activeIndex]
      if (item?.kind === 'agent' && !expandedSlugs.has(item.agent.slug)) {
        toggleExpand(item.agent.slug)
      }
    } else if (e.key === 'ArrowLeft' && !isSearchMode) {
      e.preventDefault()
      const item = flatItems[activeIndex]
      if (item?.kind === 'agent' && expandedSlugs.has(item.agent.slug)) {
        toggleExpand(item.agent.slug)
      } else if (item?.kind === 'dashboard' || item?.kind === 'session') {
        // Collapse the parent agent and move focus to it
        toggleExpand(item.agent.slug)
        const agentIdx = flatItems.findIndex(
          (fi) => fi.kind === 'agent' && fi.agent.slug === item.agent.slug
        )
        if (agentIdx >= 0) setActiveIndex(agentIdx)
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flatItems[activeIndex]
      if (item) handleSelect(item)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) closeSearch() }}>
      {/* Installed-PWA full-bleed: the box is top-anchored (top-4), so a top margin of the
          safe-area inset drops the whole palette (input + close control) below the Dynamic Island.
          env() is 0 on desktop / non-standalone mobile Safari; md: resets it (desktop centers). */}
      <DialogContent
        hideClose
        className="search-anim top-4 w-[calc(100%-1.5rem)] max-w-[680px] translate-y-0 gap-0 overflow-hidden rounded-2xl border-border/60 bg-background p-0 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.32),0_8px_24px_-12px_rgba(0,0,0,0.18)] mt-[env(safe-area-inset-top)] md:top-[46%] md:-translate-y-1/2 md:mt-0 dark:border-white/10 dark:shadow-[0_28px_90px_-24px_rgba(0,0,0,0.72)]"
        onKeyDown={handleKeyDown}
        aria-label="Search agents, dashboards, and sessions"
      >
        <DialogTitle className="sr-only">Search agents, dashboards, and sessions</DialogTitle>
        <DialogDescription className="sr-only">Find agents, dashboards, and sessions by name</DialogDescription>
        <div className="flex min-h-16 items-center gap-3 border-b border-border/70 px-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/70 text-muted-foreground shadow-sm">
            <Search className="size-4" strokeWidth={2} />
          </div>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIndex(0)
            }}
            placeholder="Search anything…"
            className="min-w-0 flex-1 bg-transparent text-base leading-none outline-none placeholder:text-muted-foreground/70"
            data-testid="search-input"
            role="combobox"
            aria-label="Search agents, dashboards, and sessions"
            aria-autocomplete="list"
            aria-controls="quick-search-results"
            aria-expanded={open}
            aria-activedescendant={flatItems.length > 0 ? `quick-search-option-${activeIndex}` : undefined}
          />
          <DialogClose asChild>
            <button
              type="button"
              aria-label="Close search"
              className="shrink-0 rounded-md border border-border/60 bg-muted/50 px-1.5 py-1 font-mono text-[10px] leading-none text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              esc
            </button>
          </DialogClose>
        </div>
        <div className="flex items-center justify-between px-4 pb-1.5 pt-3">
          <span className="text-2xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {isSearchMode ? 'Search results' : 'Recently active'}
          </span>
          {flatItems.length > 0 && (
            <span className="text-2xs tabular-nums text-muted-foreground/80">
              {flatItems.length} {flatItems.length === 1 ? 'result' : 'results'}
            </span>
          )}
        </div>
        <div
          ref={listRef}
          id="quick-search-results"
          role="listbox"
          aria-label={isSearchMode ? 'Search results' : 'Recently active agents'}
          className="relative max-h-[min(56vh,520px)] scroll-py-2 overflow-y-auto px-2 pb-2 pt-0.5"
          data-testid="search-results"
        >
          <SearchSelectionIndicator
            activeIndex={activeIndex}
            items={flatItems}
            listRef={listRef}
            open={open}
          />
          {flatItems.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center px-6 py-8 text-center" role="status">
              <div className="mb-3 flex size-10 items-center justify-center rounded-xl border border-border/60 bg-muted/50 text-muted-foreground shadow-sm">
                <SearchX className="size-4" />
              </div>
              <p className="text-sm font-medium text-foreground">
                {isSearchMode ? 'No matches found' : 'No recent agents'}
              </p>
              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                {isSearchMode
                  ? 'Try a different agent, dashboard, or session name.'
                  : 'Agents you use will appear here for quick access.'}
              </p>
            </div>
          ) : (
            (() => {
              let idx = 0
              return visibleGroups.map((g) => {
                const agentIdx = idx++
                const isExpanded = isSearchMode || expandedSlugs.has(g.agent.slug)
                const hasChildren = g.dashboards.length > 0 || g.sessions.length > 0
                return (
                  <div key={g.agent.slug} role="group" aria-label={g.agent.name} className="py-0.5">
                    <button
                      type="button"
                      id={`quick-search-option-${agentIdx}`}
                      role="option"
                      aria-selected={activeIndex === agentIdx}
                      aria-expanded={!isSearchMode && hasChildren ? isExpanded : undefined}
                      data-index={agentIdx}
                      data-testid="search-agent-row"
                      data-agent-name={g.agent.name}
                      data-agent-slug={g.agent.slug}
                      onClick={() => handleSelect({ kind: 'agent', agent: g.agent })}
                      onMouseEnter={() => setActiveIndex(agentIdx)}
                      className={cn(
                        'group relative z-[1] flex min-h-11 w-full items-center gap-3 rounded-xl px-2.5 py-1.5 text-left text-sm outline-none transition-colors',
                        activeIndex === agentIdx
                          ? 'text-accent-foreground'
                          : 'hover:bg-accent/50'
                      )}
                    >
                      <span className={cn(
                        'flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/60 text-muted-foreground shadow-sm transition-colors',
                        activeIndex === agentIdx && 'bg-background text-foreground'
                      )}>
                        <Bot className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          <HighlightMatch
                            text={g.agent.name}
                            query={normalizedQuery}
                            highlightClassName="bg-foreground/10 text-foreground dark:bg-foreground/15"
                          />
                        </span>
                        {isSearchMode && (
                          <span className="mt-0.5 block text-2xs text-muted-foreground">Agent</span>
                        )}
                      </span>
                      {!isSearchMode && g.agent.lastActivityAt && (
                        <span className="ml-auto hidden shrink-0 text-2xs text-muted-foreground sm:block">
                          {formatLastRun(g.agent.lastActivityAt)}
                        </span>
                      )}
                      {!isSearchMode && hasChildren ? (
                        <ChevronRight
                          data-testid="search-agent-expand"
                          data-agent-slug={g.agent.slug}
                          aria-hidden="true"
                          className={cn(
                            'size-4 shrink-0 rounded-sm p-0.5 text-muted-foreground transition-transform hover:bg-background/70 hover:text-foreground',
                            isExpanded && 'rotate-90'
                          )}
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleExpand(g.agent.slug)
                          }}
                        />
                      ) : activeIndex === agentIdx ? (
                        <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : null}
                    </button>
                    {isExpanded && (
                      <div className="relative ml-[26px] border-l border-border/70 py-0.5 pl-3">
                        {g.dashboards.map((d) => {
                          const dashboardIdx = idx++
                          return (
                            <button
                              key={d.slug}
                              type="button"
                              id={`quick-search-option-${dashboardIdx}`}
                              role="option"
                              aria-selected={activeIndex === dashboardIdx}
                              data-index={dashboardIdx}
                              data-testid="search-dashboard-row"
                              data-agent-name={g.agent.name}
                              data-agent-slug={g.agent.slug}
                              data-dashboard-name={d.name}
                              data-dashboard-slug={d.slug}
                              onClick={() => handleSelect({ kind: 'dashboard', agent: g.agent, dashboard: d })}
                              onMouseEnter={() => setActiveIndex(dashboardIdx)}
                              className={cn(
                                'group relative z-[1] flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors',
                                activeIndex === dashboardIdx
                                  ? 'text-accent-foreground'
                                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                              )}
                            >
                              <LayoutDashboard className="size-3.5 shrink-0" />
                              <span className="min-w-0 flex-1 truncate">
                                <HighlightMatch
                                  text={d.name}
                                  query={normalizedQuery}
                                  highlightClassName="bg-foreground/10 text-foreground dark:bg-foreground/15"
                                />
                              </span>
                              {isSearchMode && activeIndex !== dashboardIdx && (
                                <span className="hidden text-2xs text-muted-foreground/80 sm:block">Dashboard</span>
                              )}
                              {activeIndex === dashboardIdx && (
                                <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />
                              )}
                            </button>
                          )
                        })}
                        {g.sessions.map((s) => {
                          const sessionIdx = idx++
                          return (
                            <button
                              key={s.id}
                              type="button"
                              id={`quick-search-option-${sessionIdx}`}
                              role="option"
                              aria-selected={activeIndex === sessionIdx}
                              data-index={sessionIdx}
                              data-testid="search-session-row"
                              data-agent-name={g.agent.name}
                              data-agent-slug={g.agent.slug}
                              data-session-name={s.name}
                              data-session-id={s.id}
                              onClick={() => handleSelect({ kind: 'session', agent: g.agent, session: s })}
                              onMouseEnter={() => setActiveIndex(sessionIdx)}
                              className={cn(
                                'group relative z-[1] flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors',
                                activeIndex === sessionIdx
                                  ? 'text-accent-foreground'
                                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                              )}
                            >
                              <MessageSquare className="size-3.5 shrink-0" />
                              <span className="min-w-0 flex-1 truncate">
                                <HighlightMatch
                                  text={s.name}
                                  query={normalizedQuery}
                                  highlightClassName="bg-foreground/10 text-foreground dark:bg-foreground/15"
                                />
                              </span>
                              {!isSearchMode && s.lastActivityAt && activeIndex !== sessionIdx && (
                                <span className="ml-auto hidden shrink-0 text-2xs text-muted-foreground sm:block">
                                  {formatLastRun(s.lastActivityAt)}
                                </span>
                              )}
                              {isSearchMode && activeIndex !== sessionIdx && (
                                <span className="hidden text-2xs text-muted-foreground/80 sm:block">Session</span>
                              )}
                              {activeIndex === sessionIdx && (
                                <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />
                              )}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })
            })()
          )}
        </div>
        <div className="hidden items-center gap-4 border-t border-border/70 bg-muted/30 px-4 py-2 text-2xs text-muted-foreground sm:flex">
          <span className="flex items-center gap-1.5">
            <kbd className="font-mono text-foreground/70">↑↓</kbd>
            Navigate
          </span>
          {!isSearchMode && (
            <span className="flex items-center gap-1.5">
              <kbd className="font-mono text-foreground/70">←→</kbd>
              Expand
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <kbd className="font-mono text-foreground/70">↵</kbd>
            Open
          </span>
          <span className="ml-auto">Agents · dashboards · sessions</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
