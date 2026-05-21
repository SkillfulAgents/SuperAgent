import { useState, useMemo, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Search, ChevronLeft, ChevronRight, Filter, Check } from 'lucide-react'
import { DiscoverableSkillCard } from '../discoverable-skill-card'
import type { ApiDiscoverableSkill } from '@shared/lib/types/api'

const SKILLS_PER_PAGE = 30

interface HomeSkillsBrowseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentSlug: string
  discoverableSkills: ApiDiscoverableSkill[]
}

export function HomeSkillsBrowseDialog({
  open,
  onOpenChange,
  agentSlug,
  discoverableSkills,
}: HomeSkillsBrowseDialogProps) {
  const [skillSearch, setSkillSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [skillPage, setSkillPage] = useState(0)
  const [selectedSkillsets, setSelectedSkillsets] = useState<Set<string> | null>(null)

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(skillSearch), 150)
    return () => clearTimeout(id)
  }, [skillSearch])

  const skillsetList = useMemo(() => {
    const seen = new Map<string, string>()
    for (const s of discoverableSkills) {
      if (!seen.has(s.skillsetId)) seen.set(s.skillsetId, s.skillsetName)
    }
    return Array.from(seen, ([id, name]) => ({ id, name }))
  }, [discoverableSkills])

  const activeSkillsets = useMemo(
    () => selectedSkillsets ?? new Set(skillsetList.map((s) => s.id)),
    [selectedSkillsets, skillsetList]
  )

  const filteredSkills = useMemo(() => {
    return discoverableSkills.filter((s) => {
      if (!activeSkillsets.has(s.skillsetId)) return false
      if (!debouncedSearch.trim()) return true
      const q = debouncedSearch.toLowerCase()
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    })
  }, [discoverableSkills, debouncedSearch, activeSkillsets])

  const totalPages = Math.ceil(filteredSkills.length / SKILLS_PER_PAGE)
  const pagedSkills = filteredSkills.slice(
    skillPage * SKILLS_PER_PAGE,
    (skillPage + 1) * SKILLS_PER_PAGE
  )

  useEffect(() => {
    setSkillPage(0)
  }, [debouncedSearch, selectedSkillsets])

  useEffect(() => {
    if (!open) {
      setSkillSearch('')
      setDebouncedSearch('')
      setSkillPage(0)
      setSelectedSkillsets(null)
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" onOpenAutoFocus={(e) => e.preventDefault()} data-testid="skills-browse-dialog">
        <DialogHeader>
          <DialogTitle>Browse & add skills from your team</DialogTitle>
          <DialogDescription className="sr-only">Search and add shared skills to this agent</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2 mt-4">
          <div className="relative w-56">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={skillSearch}
              onChange={(e) => setSkillSearch(e.target.value)}
              placeholder="Search skills..."
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

        <div className="min-h-[60vh]">
          {filteredSkills.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">
              {debouncedSearch.trim()
                ? `No skills matching "${debouncedSearch}"`
                : 'No skills available'}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 items-start py-1">
              {pagedSkills.map((skill) => (
                <DiscoverableSkillCard
                  key={`${skill.skillsetId}/${skill.path}`}
                  skill={skill}
                  agentSlug={agentSlug}
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
              onClick={() => setSkillPage((p) => p - 1)}
              disabled={skillPage === 0}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-xs text-muted-foreground">
              {skillPage + 1} / {totalPages}
            </span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => setSkillPage((p) => p + 1)}
              disabled={skillPage >= totalPages - 1}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
