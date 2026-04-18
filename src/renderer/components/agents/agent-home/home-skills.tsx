import { useState, useMemo, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Search, ChevronLeft, ChevronRight, Filter, MoreVertical, FileCode, CloudUpload, GitPullRequest, Send, RefreshCw, Loader2 } from 'lucide-react'
import { DiscoverableSkillCard } from '../discoverable-skill-card'
import { StatusBadge } from '../status-badge'
import { SkillFilesDialog } from '../skill-files-dialog'
import { SkillPublishDialog } from '../skill-publish-dialog'
import { SkillPRDialog } from '../skill-pr-dialog'
import { HomeCollapsible } from './home-collapsible'
import { useAgentSkills, useDiscoverableSkills, useUpdateSkill } from '@renderer/hooks/use-agent-skills'
import { useSkillsetPublishMode } from '@renderer/hooks/use-skillsets'
import { getReviewActionLabel, isPullRequestPublishMode } from '@renderer/lib/skillset-publish-ui'
import type { ApiSkillWithStatus } from '@shared/lib/types/api'

const SKILLS_PER_PAGE = 6

interface HomeSkillsProps {
  agentSlug: string
}

export function HomeSkills({ agentSlug }: HomeSkillsProps) {
  const [skillSearch, setSkillSearch] = useState('')
  const [skillPage, setSkillPage] = useState(0)
  const [selectedSkillsets, setSelectedSkillsets] = useState<Set<string> | null>(null)

  const { data: skillsData } = useAgentSkills(agentSlug)
  const skills = Array.isArray(skillsData) ? skillsData : []
  const { data: discoverableSkillsData } = useDiscoverableSkills(agentSlug)
  const discoverableSkills = useMemo(() => Array.isArray(discoverableSkillsData) ? discoverableSkillsData : [], [discoverableSkillsData])

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
      if (!skillSearch.trim()) return true
      const q = skillSearch.toLowerCase()
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    })
  }, [discoverableSkills, skillSearch, activeSkillsets])

  const totalPages = Math.ceil(filteredSkills.length / SKILLS_PER_PAGE)
  const pagedSkills = filteredSkills.slice(
    skillPage * SKILLS_PER_PAGE,
    (skillPage + 1) * SKILLS_PER_PAGE
  )

  useEffect(() => {
    setSkillPage(0)
  }, [skillSearch, selectedSkillsets])

  return (
    <HomeCollapsible title="Skills">
      {skills.length === 0 && discoverableSkills.length === 0 && (
        <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
          <p className="text-xs font-medium text-foreground">No skills yet</p>
          <p className="text-xs mt-1">Skills teach your agent how to do specific tasks, like triaging emails. Your agent builds skills for you as it works.</p>
        </div>
      )}

      {skills.length > 0 && (
        <div className="mt-2 divide-y divide-border/50">
          {skills.map((skill) => (
            <SkillRow key={skill.path} skill={skill} agentSlug={agentSlug} />
          ))}
        </div>
      )}

      {discoverableSkills.length > 0 && (
        <>
          {skills.length > 0 && (
            <div className="border-t my-3" />
          )}
          <div className="flex items-center gap-1.5 mb-2 px-4">
            <span className="text-xs text-muted-foreground">Discover</span>
            <div className="ml-auto flex items-center gap-1.5">
              {skillsetList.length > 0 && (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 relative"
                      title="Filter by skillset"
                      aria-label="Filter by skillset"
                    >
                      <Filter className="h-3 w-3 text-muted-foreground" />
                      {selectedSkillsets && selectedSkillsets.size < skillsetList.length && (
                        <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary" />
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-56 p-3">
                    <p className="text-xs font-medium mb-2">Filter by skillset</p>
                    <div className="space-y-2">
                      {skillsetList.map((ss) => (
                        <label key={ss.id} className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={activeSkillsets.has(ss.id)}
                            onCheckedChange={(checked) => {
                              const next = new Set(activeSkillsets)
                              if (checked) {
                                next.add(ss.id)
                              } else {
                                next.delete(ss.id)
                              }
                              setSelectedSkillsets(
                                next.size === skillsetList.length ? null : next
                              )
                            }}
                          />
                          <span className="text-xs truncate">{ss.name}</span>
                        </label>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
              <div className="relative w-36">
                <Input
                  value={skillSearch}
                  onChange={(e) => setSkillSearch(e.target.value)}
                  placeholder="Search..."
                  className="h-6 text-xs pr-6"
                />
                <Search className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
              </div>
            </div>
          </div>
          <div className="divide-y divide-border/50 px-4">
            {pagedSkills.map((skill) => (
              <DiscoverableSkillCard
                key={`${skill.skillsetId}/${skill.path}`}
                skill={skill}
                agentSlug={agentSlug}
              />
            ))}
            {filteredSkills.length === 0 && skillSearch.trim() && (
              <p className="text-xs text-muted-foreground text-center py-3">
                No skills matching &ldquo;{skillSearch}&rdquo;
              </p>
            )}
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-3">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => setSkillPage((p) => p - 1)}
                disabled={skillPage === 0}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="text-xs text-muted-foreground">
                {skillPage + 1} / {totalPages}
              </span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => setSkillPage((p) => p + 1)}
                disabled={skillPage >= totalPages - 1}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </>
      )}
    </HomeCollapsible>
  )
}

function SkillRow({ skill, agentSlug }: { skill: ApiSkillWithStatus; agentSlug: string }) {
  const [filesOpen, setFilesOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const updateSkill = useUpdateSkill()
  const publishMode = useSkillsetPublishMode(skill.status.skillsetId)
  const ReviewIcon = isPullRequestPublishMode(publishMode) ? GitPullRequest : Send
  const actionLabel = getReviewActionLabel(publishMode)

  return (
    <>
      <div role="button" tabIndex={0} className="group relative py-3 px-4 hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => setFilesOpen(true)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFilesOpen(true) } }}>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium truncate">{skill.name ?? skill.path}</span>
          <StatusBadge status={skill.status} />
        </div>
        {skill.description && (
          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{skill.description}</div>
        )}
        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-6 w-6"
                aria-label={`Actions for ${skill.name ?? 'skill'}`}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-36 p-1" onClick={(e) => e.stopPropagation()}>
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                onClick={(e) => { e.stopPropagation(); setFilesOpen(true) }}
              >
                <FileCode className="h-3.5 w-3.5" />
                View Files
              </button>
              {skill.status.type === 'local' && skill.status.publishable !== false && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                  onClick={(e) => { e.stopPropagation(); setPublishOpen(true) }}
                >
                  <CloudUpload className="h-3.5 w-3.5" />
                  Publish Skill
                </button>
              )}
              {skill.status.type === 'update_available' && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                  disabled={updateSkill.isPending}
                  onClick={(e) => { e.stopPropagation(); updateSkill.mutate({ agentSlug, skillDir: skill.path }) }}
                >
                  {updateSkill.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  Update
                </button>
              )}
              {skill.status.type === 'locally_modified' && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                  onClick={(e) => { e.stopPropagation(); setReviewOpen(true) }}
                >
                  <ReviewIcon className="h-3.5 w-3.5" />
                  {actionLabel}
                </button>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <SkillFilesDialog
        open={filesOpen}
        onOpenChange={setFilesOpen}
        agentSlug={agentSlug}
        skillDir={skill.path}
        skillName={skill.name}
      />
      <SkillPublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        agentSlug={agentSlug}
        skillDir={skill.path}
        skillStatus={skill.status}
        onOpenReview={() => setReviewOpen(true)}
      />
      <SkillPRDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        agentSlug={agentSlug}
        skillDir={skill.path}
        publishMode={publishMode}
      />
    </>
  )
}
