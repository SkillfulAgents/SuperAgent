import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
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
import {
  useForceSyncAgentTemplate,
  useRefreshAgentTemplateStatus,
  useUpdateAgentTemplate,
} from '@renderer/hooks/use-agent-templates'
import type { ApiItemStatus } from '@shared/lib/types/api'
import { StatusBadge } from '@renderer/components/agents/status-badge'
import { AgentTemplatePRDialog } from '@renderer/components/agents/agent-template-pr-dialog'
import { RefreshCw, GitPullRequest, Send, Loader2 } from 'lucide-react'
import { getReviewActionLabel, isPullRequestPublishMode } from '@renderer/lib/skillset-publish-ui'
import { useSkillsetPublishMode } from '@renderer/hooks/use-skillsets'

interface AgentTemplateStatusProps {
  agentSlug: string
  templateStatus: ApiItemStatus
}

/**
 * Template Status for an agent installed from a library: the status badge
 * with a refresh, and the actions that follow from it — Update when the
 * upstream template moved on, Force Sync / Submit for review when the local
 * copy was modified. Lived on the settings dialog's General tab until that
 * dialog went; now the Share popover's Publish pane shows it for agents that
 * can't be published because they already come from a library.
 */
export function AgentTemplateStatus({ agentSlug, templateStatus }: AgentTemplateStatusProps) {
  const [prDialogOpen, setPrDialogOpen] = useState(false)
  const [forceSyncDialogOpen, setForceSyncDialogOpen] = useState(false)
  const refreshTemplateStatus = useRefreshAgentTemplateStatus()
  const forceSyncTemplate = useForceSyncAgentTemplate()
  const updateTemplate = useUpdateAgentTemplate()
  const templateSourceLabel = templateStatus.sourceLabel || null
  const publishMode = useSkillsetPublishMode(templateStatus.skillsetId)
  const isPR = isPullRequestPublishMode(publishMode)
  const SubmitIcon = isPR ? GitPullRequest : Send

  return (
    <div className="space-y-2" data-testid="agent-template-status">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Template Status</h3>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          onClick={() => refreshTemplateStatus.mutate({ agentSlug })}
          disabled={refreshTemplateStatus.isPending}
          title="Refresh template status from upstream"
          aria-label="Refresh template status from upstream"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshTemplateStatus.isPending ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge status={templateStatus} />
        {templateSourceLabel && (
          <span className="text-xs text-muted-foreground">
            {templateSourceLabel}
          </span>
        )}
      </div>
      <div className="flex gap-2 mt-2">
        {templateStatus.type === 'update_available' && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => updateTemplate.mutate({ agentSlug })}
            disabled={updateTemplate.isPending}
            data-testid="agent-template-update-button"
          >
            {updateTemplate.isPending ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3 mr-1" />
            )}
            Update
          </Button>
        )}
        {templateStatus.type === 'locally_modified' && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setForceSyncDialogOpen(true)}
              disabled={forceSyncTemplate.isPending}
              data-testid="agent-template-force-sync-button"
            >
              {forceSyncTemplate.isPending ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1" />
              )}
              Force Sync
            </Button>
            {!templateStatus.openPrUrl && publishMode !== 'none' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPrDialogOpen(true)}
                data-testid="agent-template-submit-button"
              >
                <SubmitIcon className="h-3 w-3 mr-1" />
                {getReviewActionLabel(publishMode)}
              </Button>
            )}
          </>
        )}
      </div>

      <AgentTemplatePRDialog
        open={prDialogOpen}
        onOpenChange={setPrDialogOpen}
        agentSlug={agentSlug}
        publishMode={publishMode}
      />

      <AlertDialog open={forceSyncDialogOpen} onOpenChange={setForceSyncDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force sync template from remote?</AlertDialogTitle>
            <AlertDialogDescription>
              This will discard your local template changes and replace them with the latest
              version from the skillset.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={forceSyncTemplate.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                forceSyncTemplate.mutate(
                  { agentSlug },
                  { onSuccess: () => setForceSyncDialogOpen(false) }
                )
              }}
              disabled={forceSyncTemplate.isPending}
            >
              {forceSyncTemplate.isPending ? 'Syncing...' : 'Force Sync'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
