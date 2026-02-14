import { useState } from 'react'
import { Sparkles, RefreshCw, GitPullRequest, ExternalLink, Loader2, Upload } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useUpdateSkill } from '@renderer/hooks/use-agent-skills'
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

  const statusBadge = () => {
    switch (skill.status.type) {
      case 'up_to_date':
        return (
          <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">
            Up to date
          </span>
        )
      case 'update_available':
        return (
          <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-700 dark:text-yellow-400">
            Update available
          </span>
        )
      case 'locally_modified':
        return skill.status.openPrUrl ? (
          <a
            href={skill.status.openPrUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-700 dark:text-purple-400 hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            PR opened
          </a>
        ) : (
          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-700 dark:text-blue-400">
            Locally modified
          </span>
        )
      default:
        return null
    }
  }

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors">
      <Sparkles className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium truncate">{skill.name}</p>
          {statusBadge()}
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
