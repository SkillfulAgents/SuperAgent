import { useState, useMemo } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { MoreVertical, FileCode, CloudUpload, GitPullRequest, Send, RefreshCw, Loader2, Plus, Play } from 'lucide-react'
import { StatusBadge } from '../status-badge'
import { SkillFilesDialog } from '../skill-files-dialog'
import { SkillPublishDialog } from '../skill-publish-dialog'
import { SkillPRDialog } from '../skill-pr-dialog'
import { HomeCollapsible } from './home-collapsible'
import { HomeSkillsBrowseDialog } from './home-skills-browse-dialog'
import { useAgentSkills, useDiscoverableSkills, useUpdateSkill } from '@renderer/hooks/use-agent-skills'
import { useSkillsetPublishMode } from '@renderer/hooks/use-skillsets'
import { getReviewActionLabel, isPullRequestPublishMode } from '@renderer/lib/skillset-publish-ui'
import type { ApiSkillWithStatus } from '@shared/lib/types/api'

interface HomeSkillsProps {
  agentSlug: string
  className?: string
  onRunSkill?: (skillName: string) => void
}

export function HomeSkills({ agentSlug, className, onRunSkill }: HomeSkillsProps) {
  const [browseOpen, setBrowseOpen] = useState(false)

  const { data: skillsData } = useAgentSkills(agentSlug)
  const skills = Array.isArray(skillsData) ? skillsData : []
  const { data: discoverableSkillsData } = useDiscoverableSkills(agentSlug)
  const discoverableSkills = useMemo(
    () => (Array.isArray(discoverableSkillsData) ? discoverableSkillsData : []),
    [discoverableSkillsData]
  )

  const hasDiscoverable = discoverableSkills.length > 0

  return (
    <HomeCollapsible title="Skills" className={className}>
      {skills.length === 0 ? (
        <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
          <p className="text-xs font-medium text-foreground">No skills yet</p>
          <p className="text-xs mt-1">Skills teach your agent how to do specific tasks, like triaging emails. Your agent builds skills for you as it works.</p>
        </div>
      ) : (
        <div className="mt-2 divide-y divide-border/50" data-testid="installed-skills-list">
          {skills.map((skill) => (
            <SkillRow key={skill.path} skill={skill} agentSlug={agentSlug} onRunSkill={onRunSkill} />
          ))}
        </div>
      )}

      {hasDiscoverable && (
        <div className="flex justify-end mt-3 px-4 pb-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setBrowseOpen(true)}
            data-testid="add-skill-button"
          >
            <Plus />
            Add Skill
          </Button>
        </div>
      )}

      <HomeSkillsBrowseDialog
        open={browseOpen}
        onOpenChange={setBrowseOpen}
        agentSlug={agentSlug}
        discoverableSkills={discoverableSkills}
      />
    </HomeCollapsible>
  )
}

function SkillRow({ skill, agentSlug, onRunSkill }: { skill: ApiSkillWithStatus; agentSlug: string; onRunSkill?: (skillName: string) => void }) {
  const [filesOpen, setFilesOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const updateSkill = useUpdateSkill()
  const publishMode = useSkillsetPublishMode(skill.status.skillsetId)
  const ReviewIcon = isPullRequestPublishMode(publishMode) ? GitPullRequest : Send
  const actionLabel = getReviewActionLabel(publishMode)

  return (
    <>
      <div role="button" tabIndex={0} data-testid="installed-skill-row" data-skill-path={skill.path} className="group relative py-3 px-4 hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => setFilesOpen(true)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFilesOpen(true) } }}>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium truncate">{skill.name ?? skill.path}</span>
          <StatusBadge status={skill.status} />
        </div>
        {skill.description && (
          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{skill.description}</div>
        )}
        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
          {onRunSkill && (
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-6 w-6"
              aria-label={`Run ${skill.name ?? 'skill'}`}
              onClick={(e) => { e.stopPropagation(); onRunSkill(skill.path) }}
            >
              <Play className="h-3 w-3" />
            </Button>
          )}
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
              {skill.status.type === 'local' && skill.status.publishable !== false && publishMode !== 'none' && (
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
              {skill.status.type === 'locally_modified' && publishMode !== 'none' && (
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
