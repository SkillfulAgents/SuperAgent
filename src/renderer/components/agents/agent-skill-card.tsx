import { useState } from 'react'
import { Sparkles, RefreshCw, GitPullRequest, Loader2, Upload } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useUpdateSkill } from '@renderer/hooks/use-agent-skills'
import { StatusBadge } from './status-badge'
import { SkillPRDialog } from './skill-pr-dialog'
import { SkillPublishDialog } from './skill-publish-dialog'
import type { ApiSkillWithStatus } from '@shared/lib/types/api'

interface AgentSkillCardProps {
  skill: ApiSkillWithStatus
  agentSlug: string
}

export function AgentSkillCard({ skill, agentSlug }: AgentSkillCardProps) {
  const updateSkill = useUpdateSkill()
  const [prDialogOpen, setPrDialogOpen] = useState(false)
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors">
      <Sparkles className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium truncate">{skill.name}</p>
          <StatusBadge status={skill.status} />
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
          {skill.description}
        </p>
        {skill.status.skillsetName && (
          <p className="text-xs text-muted-foreground mt-1">
            From: {skill.status.skillsetName}
          </p>
        )}
      </div>
      <div className="flex gap-1 shrink-0">
        {skill.status.type === 'update_available' && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => updateSkill.mutate({ agentSlug, skillDir: skill.path })}
            disabled={updateSkill.isPending}
          >
            {updateSkill.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <>
                <RefreshCw className="h-3 w-3 mr-1" />
                Update
              </>
            )}
          </Button>
        )}
        {skill.status.type === 'locally_modified' && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => setPrDialogOpen(true)}
          >
            <GitPullRequest className="h-3 w-3 mr-1" />
            Open PR
          </Button>
        )}
        {skill.status.type === 'local' && (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            onClick={() => setPublishDialogOpen(true)}
            title="Publish to skillset"
          >
            <Upload className="h-4 w-4" />
          </Button>
        )}
      </div>
      <SkillPRDialog
        open={prDialogOpen}
        onOpenChange={setPrDialogOpen}
        agentSlug={agentSlug}
        skillDir={skill.path}
      />
      <SkillPublishDialog
        open={publishDialogOpen}
        onOpenChange={setPublishDialogOpen}
        agentSlug={agentSlug}
        skillDir={skill.path}
      />
    </div>
  )
}
