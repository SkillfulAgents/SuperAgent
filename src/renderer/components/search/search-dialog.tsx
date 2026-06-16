import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { Bot, ChevronRight, MessageSquare, Search } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@renderer/components/ui/dialog'
import { HighlightMatch } from '@renderer/components/ui/highlight-match'
import { useAgents } from '@renderer/hooks/use-agents'
import { useSelection } from '@renderer/context/selection-context'
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

interface SearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SearchDialog({ open, onOpenChange }: SearchDialogProps) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [expandedSlugs, setExpandedSlugs] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { setAgent } = useSelection()
  const navigate = useNavigate()
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

  const sessionsByAgent = useMemo(() => {
    if (!agents) return {}
    const map: Record<string, ApiSession[]> = {}
    agents.forEach((a, i) => {
      map[a.slug] = sessionQueries[i]?.data ?? []
    })
    return map
  }, [agents, sessionQueries])

  const isSearchMode = query.trim().length > 0

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
    onOpenChange(false)
    if (item.kind === 'agent') {
      setAgent(item.agent.slug)
    } else {
      setAgent(item.agent.slug, { kind: 'session', id: item.session.id })
    }
    void navigate({ to: '/agents/$slug', params: { slug: item.agent.slug } })
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
      } else if (item?.kind === 'session') {
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl p-0 gap-0 overflow-hidden [&>button]:top-3 [&>button]:right-3"
        onKeyDown={handleKeyDown}
        aria-label="Search agents and sessions"
      >
        <DialogTitle className="sr-only">Search agents and sessions</DialogTitle>
        <DialogDescription className="sr-only">Find agents and sessions by name</DialogDescription>
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIndex(0)
            }}
            placeholder="Search agents and sessions..."
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
            data-testid="search-input"
          />
        </div>
        <div
          ref={listRef}
          className="max-h-[60vh] overflow-y-auto py-1"
          data-testid="search-results"
        >
          {flatItems.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              {isSearchMode ? 'No matches found' : 'No recent agents'}
            </div>
          ) : (
            (() => {
              let idx = 0
              return visibleGroups.map((g) => {
                const agentIdx = idx++
                const isExpanded = isSearchMode || expandedSlugs.has(g.agent.slug)
                const hasSessions = g.sessions.length > 0
                return (
                  <div key={g.agent.slug} className="py-1">
                    <button
                      type="button"
                      data-index={agentIdx}
                      data-testid="search-agent-row"
                      data-agent-name={g.agent.name}
                      data-agent-slug={g.agent.slug}
                      onClick={() => handleSelect({ kind: 'agent', agent: g.agent })}
                      onMouseEnter={() => setActiveIndex(agentIdx)}
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm rounded-sm',
                        activeIndex === agentIdx ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                      )}
                    >
                      {!isSearchMode && hasSessions && (
                        <ChevronRight
                          data-testid="search-agent-expand"
                          data-agent-slug={g.agent.slug}
                          className={cn(
                            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                            isExpanded && 'rotate-90'
                          )}
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleExpand(g.agent.slug)
                          }}
                        />
                      )}
                      {!isSearchMode && !hasSessions && (
                        <span className="w-3.5 shrink-0" />
                      )}
                      <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium">
                        <HighlightMatch text={g.agent.name} query={query} />
                      </span>
                      {!isSearchMode && g.agent.lastActivityAt && (
                        <span className="ml-auto shrink-0 text-xs italic text-muted-foreground">
                          {formatLastRun(g.agent.lastActivityAt)}
                        </span>
                      )}
                    </button>
                    {isExpanded && g.sessions.map((s) => {
                      const sessionIdx = idx++
                      return (
                        <button
                          key={s.id}
                          type="button"
                          data-index={sessionIdx}
                          data-testid="search-session-row"
                          data-agent-name={g.agent.name}
                          data-agent-slug={g.agent.slug}
                          data-session-name={s.name}
                          data-session-id={s.id}
                          onClick={() => handleSelect({ kind: 'session', agent: g.agent, session: s })}
                          onMouseEnter={() => setActiveIndex(sessionIdx)}
                          className={cn(
                            'w-full flex items-center gap-2 pl-9 pr-3 py-1.5 text-left text-sm rounded-sm',
                            activeIndex === sessionIdx ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                          )}
                        >
                          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate text-muted-foreground">
                            <HighlightMatch text={s.name} query={query} />
                          </span>
                          {!isSearchMode && s.lastActivityAt && (
                            <span className="ml-auto shrink-0 text-xs italic text-muted-foreground">
                              {formatLastRun(s.lastActivityAt)}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )
              })
            })()
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
