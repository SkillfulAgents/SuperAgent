import { useState, useMemo, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Search, ChevronLeft, ChevronRight, Filter, Check } from 'lucide-react'
import { TemplateCard } from './template-card'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

const TEMPLATES_PER_PAGE = 30

export interface AgentTemplateBrowseContentProps {
  discoverableAgents: ApiDiscoverableAgent[]
  onSelect: (template: ApiDiscoverableAgent) => void
  /** Set a minimum height on the results area (e.g. '60vh'). Useful inside dialogs. */
  minHeight?: string
}

export function AgentTemplateBrowseContent({
  discoverableAgents,
  onSelect,
  minHeight,
}: AgentTemplateBrowseContentProps) {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [page, setPage] = useState(0)
  const [selectedSkillsets, setSelectedSkillsets] = useState<Set<string> | null>(null)

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 150)
    return () => clearTimeout(id)
  }, [search])

  const skillsetList = useMemo(() => {
    const seen = new Map<string, string>()
    for (const a of discoverableAgents) {
      if (!seen.has(a.skillsetId)) seen.set(a.skillsetId, a.skillsetName)
    }
    return Array.from(seen, ([id, name]) => ({ id, name }))
  }, [discoverableAgents])

  const activeSkillsets = useMemo(
    () => selectedSkillsets ?? new Set(skillsetList.map((s) => s.id)),
    [selectedSkillsets, skillsetList]
  )

  const filtered = useMemo(() => {
    return discoverableAgents.filter((a) => {
      if (!activeSkillsets.has(a.skillsetId)) return false
      if (!debouncedSearch.trim()) return true
      const q = debouncedSearch.toLowerCase()
      return a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)
    })
  }, [discoverableAgents, debouncedSearch, activeSkillsets])

  const totalPages = Math.ceil(filtered.length / TEMPLATES_PER_PAGE)
  const paged = filtered.slice(page * TEMPLATES_PER_PAGE, (page + 1) * TEMPLATES_PER_PAGE)

  useEffect(() => {
    setPage(0)
  }, [debouncedSearch, selectedSkillsets])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="relative w-56">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search templates..."
            className="pl-8"
          />
        </div>
        {skillsetList.length > 0 && (
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
                      if (checked) {
                        next.delete(ss.id)
                      } else {
                        next.add(ss.id)
                      }
                      setSelectedSkillsets(
                        next.size === skillsetList.length ? null : next
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

      <div style={minHeight ? { minHeight } : undefined}>
        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">
            {debouncedSearch.trim()
              ? `No templates matching "${debouncedSearch}"`
              : 'No templates available'}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2 items-start py-1">
            {paged.map((template) => (
              <TemplateCard
                key={`${template.skillsetId}/${template.path}`}
                template={template}
                variant="full"
                onClick={() => onSelect(template)}
              />
            ))}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => setPage((p) => p - 1)}
            disabled={page === 0}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground">
            {page + 1} / {totalPages}
          </span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= totalPages - 1}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
