import { useState } from 'react'
import { Sparkles, RefreshCw, GitPullRequest, Send, Loader2, Upload } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useForceSyncSkill, useUpdateSkill } from '@renderer/hooks/use-agent-skills'
import { useSkillsetPublishMode } from '@renderer/hooks/use-skillsets'
import { getReviewActionLabel, isPullRequestPublishMode } from '@renderer/lib/skillset-publish-ui'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { StatusBadge } from './status-badge'
import { SkillPRDialog } from './skill-pr-dialog'
import { SkillPublishDialog } from './skill-publish-dialog'
import { SkillContextMenu } from './skill-context-menu'
import type { ApiSkillWithStatus } from '@shared/lib/types/api'

interface AgentSkillCardProps {
  skill: ApiSkillWithStatus
  agentSlug: string
}

export function AgentSkillCard({ skill, agentSlug }: AgentSkillCardProps) {
  const updateSkill = useUpdateSkill()
  const forceSyncSkill = useForceSyncSkill()
  const [prDialogOpen, setPrDialogOpen] = useState(false)
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const [forceSyncDialogOpen, setForceSyncDialogOpen] = useState(false)
  const sourceLabel = skill.status.sourceLabel || null
  const publishMode = useSkillsetPublishMode(skill.status.skillsetId)
  const isPR = isPullRequestPublishMode(publishMode)
  const SubmitIcon = isPR ? GitPullRequest : Send

  return (
    <SkillContextMenu skill={skill} agentSlug={agentSlug}>
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
          {sourceLabel && (
            <p className="text-xs text-muted-foreground mt-1">
              {sourceLabel}
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
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setForceSyncDialogOpen(true)}
                disabled={forceSyncSkill.isPending}
              >
                {forceSyncSkill.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <>
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Force Sync
                  </>
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setPrDialogOpen(true)}
              >
                <SubmitIcon className="h-3 w-3 mr-1" />
                {getReviewActionLabel(publishMode)}
              </Button>
            </>
          )}
          {/* Hidden-org platform skills are shown as local, but must not be re-published from this org. */}
          {skill.status.type === 'local' && skill.status.publishable !== false && (
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
          publishMode={publishMode}
        />
        <SkillPublishDialog
          open={publishDialogOpen}
          onOpenChange={setPublishDialogOpen}
          agentSlug={agentSlug}
          skillDir={skill.path}
        />
        <AlertDialog open={forceSyncDialogOpen} onOpenChange={setForceSyncDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Force sync skill from remote?</AlertDialogTitle>
              <AlertDialogDescription>
                This will discard your local changes to {skill.name} and replace them with
                the latest version from the skillset.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={forceSyncSkill.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault()
                  forceSyncSkill.mutate(
                    { agentSlug, skillDir: skill.path },
                    { onSuccess: () => setForceSyncDialogOpen(false) }
                  )
                }}
                disabled={forceSyncSkill.isPending}
              >
                {forceSyncSkill.isPending ? 'Syncing...' : 'Force Sync'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </SkillContextMenu>
  )
}
