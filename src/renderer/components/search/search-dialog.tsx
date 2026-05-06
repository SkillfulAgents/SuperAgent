import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { Bot, MessageSquare, Search } from 'lucide-react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { HighlightMatch } from '@renderer/components/ui/highlight-match'
import { useAgents } from '@renderer/hooks/use-agents'
import { useSelection } from '@renderer/context/selection-context'
import { apiFetch } from '@renderer/lib/api'
import type { ApiSession } from '@shared/lib/types/api'
import { cn } from '@shared/lib/utils/cn'
import { filterAgentsAndSessions, flattenGroups, type FlatItem } from './filter'

interface SearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SearchDialog({ open, onOpenChange }: SearchDialogProps) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { setAgent } = useSelection()
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
      // Focus the input after the dialog mounts
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const visibleGroups = useMemo(() => {
    if (!agents) return []
    const sessionsByAgent: Record<string, ApiSession[]> = {}
    agents.forEach((a, i) => {
      sessionsByAgent[a.slug] = sessionQueries[i]?.data ?? []
    })
    return filterAgentsAndSessions(agents, sessionsByAgent, query)
  }, [agents, sessionQueries, query])

  const flatItems = useMemo<FlatItem[]>(() => flattenGroups(visibleGroups), [visibleGroups])

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
    if (item.kind === 'agent') {
      setAgent(item.agent.slug)
    } else {
      setAgent(item.agent.slug, { kind: 'session', id: item.session.id })
    }
    onOpenChange(false)
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl p-0 gap-0 overflow-hidden [&>button]:top-3 [&>button]:right-3"
        onKeyDown={handleKeyDown}
        aria-label="Search agents and sessions"
      >
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
          {!query.trim() || flatItems.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              {query.trim() ? 'No matches found' : 'Type to search...'}
            </div>
          ) : (
            (() => {
              let idx = 0
              return visibleGroups.map((g) => {
                const agentIdx = idx++
                return (
                  <div key={g.agent.slug} className="py-1">
                    <button
                      type="button"
                      data-index={agentIdx}
                      onClick={() => handleSelect({ kind: 'agent', agent: g.agent })}
                      onMouseEnter={() => setActiveIndex(agentIdx)}
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm rounded-sm',
                        activeIndex === agentIdx ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                      )}
                    >
                      <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium">
                        <HighlightMatch text={g.agent.name} query={query} />
                      </span>
                    </button>
                    {g.sessions.map((s) => {
                      const sessionIdx = idx++
                      return (
                        <button
                          key={s.id}
                          type="button"
                          data-index={sessionIdx}
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
