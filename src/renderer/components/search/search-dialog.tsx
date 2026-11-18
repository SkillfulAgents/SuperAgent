import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { Bot, Search } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@renderer/components/ui/dialog'
import { HighlightMatch } from '@renderer/components/ui/highlight-match'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { useAgents, type ApiAgent } from '@renderer/hooks/use-agents'
import { useSearch } from '@renderer/context/search-context'
import { useIsMobile } from '@renderer/hooks/use-mobile'
import { useNavigate } from '@tanstack/react-router'
import { apiFetch } from '@renderer/lib/api'
import type { ApiSession } from '@shared/lib/types/api'
import { cn } from '@shared/lib/utils/cn'
import { compactAgo } from '@renderer/lib/last-run'
import { flattenSections, getRecent, searchAll, type FlatItem, type SearchSections } from './filter'

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

  const trimmedQuery = query.trim()
  const isSearchMode = trimmedQuery.length > 0

  const sections = useMemo<SearchSections>(() => {
    if (!agents) return { agents: [], sessions: [], dashboards: [] }
    return isSearchMode
      ? searchAll(agents, sessionsByAgent, query)
      : getRecent(agents, sessionsByAgent)
  }, [agents, sessionsByAgent, query, isSearchMode])

  const flatItems = useMemo<FlatItem[]>(() => flattenSections(sections), [sections])

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
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flatItems[activeIndex]
      if (item) handleSelect(item)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) closeSearch() }}>
      {/* Installed-PWA full-bleed: the box is top-anchored (top-4), so a top margin of the
          safe-area inset drops the whole palette (input + close X) below the Dynamic Island.
          env() is 0 on desktop / non-standalone mobile Safari; md: resets it (desktop centers). */}
      <DialogContent
        // A fixed 640 by 560 box (narrower or shorter only when the window is), so it
        // holds still as results come and go; the list scrolls inside it.
        className="search-anim flex h-[560px] max-w-[640px] flex-col p-0 gap-0 overflow-hidden top-4 translate-y-0 mt-[env(safe-area-inset-top)] md:top-[50%] md:-translate-y-1/2 md:mt-0 [&>button]:top-6 [&>button]:right-5 md:[&>button]:hidden"
        onKeyDown={handleKeyDown}
        aria-label="Search agents, dashboards, and sessions"
      >
        <DialogTitle className="sr-only">Search agents, dashboards, and sessions</DialogTitle>
        <DialogDescription className="sr-only">Find agents, dashboards, and sessions by name</DialogDescription>
        {/* The header is the field alone: large type, no rule beneath it, and from md
            no close button (Escape or a click outside closes; touch keeps the X, so
            the field leaves room for it). Its icon sits on the rows' left edge. */}
        <div className="flex shrink-0 items-center gap-4 pb-3 pl-6 pr-12 pt-5 md:pr-6">
          <Search className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIndex(0)
            }}
            placeholder="Search agents, dashboards, and sessions..."
            className="min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground/60"
            data-testid="search-input"
          />
        </div>
        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto px-3 pb-3"
          data-testid="search-results"
        >
          {flatItems.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              {isSearchMode ? 'No matches found' : 'No recent agents'}
            </div>
          ) : (
            <>
              <ResultSection label={isSearchMode ? 'Agents' : 'Recent agents'} count={sections.agents.length}>
                {sections.agents.map((agent, i) => (
                  <ResultRow
                    key={agent.slug}
                    index={i}
                    active={activeIndex === i}
                    agent={agent}
                    title={<HighlightMatch text={agent.name} query={trimmedQuery} />}
                    subtitle={lastActive(agent.lastActivityAt)}
                    onSelect={() => handleSelect({ kind: 'agent', agent })}
                    onActivate={setActiveIndex}
                    data-testid="search-agent-row"
                    data-agent-name={agent.name}
                    data-agent-slug={agent.slug}
                  />
                ))}
              </ResultSection>
              <ResultSection label={isSearchMode ? 'Sessions' : 'Recent sessions'} count={sections.sessions.length}>
                {sections.sessions.map(({ agent, session }, i) => {
                  const index = sections.agents.length + i
                  return (
                    <ResultRow
                      key={session.id}
                      index={index}
                      active={activeIndex === index}
                      agent={agent}
                      owned
                      title={<HighlightMatch text={session.name} query={trimmedQuery} />}
                      subtitle={`${agent.name} · ${compactAgo(session.lastActivityAt)}`}
                      onSelect={() => handleSelect({ kind: 'session', agent, session })}
                      onActivate={setActiveIndex}
                      data-testid="search-session-row"
                      data-agent-name={agent.name}
                      data-agent-slug={agent.slug}
                      data-session-name={session.name}
                      data-session-id={session.id}
                    />
                  )
                })}
              </ResultSection>
              <ResultSection label="Dashboards" count={sections.dashboards.length}>
                {sections.dashboards.map(({ agent, dashboard }, i) => {
                  const index = sections.agents.length + sections.sessions.length + i
                  return (
                    <ResultRow
                      key={`${agent.slug}/${dashboard.slug}`}
                      index={index}
                      active={activeIndex === index}
                      agent={agent}
                      owned
                      title={<HighlightMatch text={dashboard.name} query={trimmedQuery} />}
                      subtitle={agent.name}
                      onSelect={() => handleSelect({ kind: 'dashboard', agent, dashboard })}
                      onActivate={setActiveIndex}
                      data-testid="search-dashboard-row"
                      data-agent-name={agent.name}
                      data-agent-slug={agent.slug}
                      data-dashboard-name={dashboard.name}
                      data-dashboard-slug={dashboard.slug}
                    />
                  )
                })}
              </ResultSection>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** An agent row's second line, with the age in its compact form: "Last active 4m ago". */
function lastActive(date: ApiAgent['lastActivityAt']): string {
  const ago = compactAgo(date)
  if (!ago) return 'Never active'
  return ago === 'now' ? 'Last active just now' : `Last active ${ago} ago`
}

/** A labelled run of rows. Nothing is drawn for a section with no rows, label included. */
function ResultSection({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null
  return (
    // Space above a section sets it apart from the one before; the first needs
    // only a little, under the header.
    <div role="group" aria-label={label} data-testid="search-section" data-section={label} className="mt-6 first:mt-2">
      <div className="px-3 pb-2 pt-2 text-xs text-muted-foreground" aria-hidden="true">
        {label}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

/**
 * One result, on two lines: its name, and a muted line beneath. An agent's row
 * leads with its avatar and says when it was last active. A session or a
 * dashboard (`owned`) belongs to an agent, so its second line names that agent
 * behind a small avatar, and the row itself has none.
 */
function ResultRow({
  index,
  active,
  agent,
  owned = false,
  title,
  subtitle,
  onSelect,
  onActivate,
  ...data
}: {
  index: number
  active: boolean
  agent: ApiAgent
  owned?: boolean
  title: React.ReactNode
  subtitle: string
  onSelect: () => void
  onActivate: (index: number) => void
} & Record<`data-${string}`, string>) {
  return (
    <button
      type="button"
      data-index={index}
      onClick={onSelect}
      // Move, not enter: a row that scrolls under a resting pointer during
      // keyboard navigation must not take the selection.
      onMouseMove={() => onActivate(index)}
      className={cn(
        'flex w-full items-center gap-4 rounded-item px-3 py-2.5 text-left',
        active && 'bg-accent text-accent-foreground'
      )}
      {...data}
    >
      {!owned && (agent.avatar
        ? <AgentAvatar agent={agent} size={28} />
        : <Bot className="size-7 shrink-0 p-0.5 text-muted-foreground" aria-hidden />)}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/70">
          {owned && agent.avatar && <AgentAvatar agent={agent} size={14} />}
          <span className="truncate">{subtitle}</span>
        </span>
      </span>
    </button>
  )
}
