
import { useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { AgentAutoDeleteSelect } from '@renderer/components/settings/auto-delete-select'
import { AgentApiLogAutoDeleteSelect } from '@renderer/components/settings/api-log-auto-delete-select'
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
import { DeleteAgentConfirmDialog } from '@renderer/components/agents/delete-agent-confirm-dialog'
import { useAgentPreferences, useUpdateAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import { useSettings } from '@renderer/hooks/use-settings'
import {
  useForceSyncAgentTemplate,
  useAgentTemplateStatus,
  useRefreshAgentTemplateStatus,
  useUpdateAgentTemplate,
} from '@renderer/hooks/use-agent-templates'
import { StatusBadge } from '@renderer/components/agents/status-badge'
import { AgentTemplatePRDialog } from '@renderer/components/agents/agent-template-pr-dialog'
import { Trash2, RefreshCw, GitPullRequest, Send, Loader2 } from 'lucide-react'
import { getReviewActionLabel, isPullRequestPublishMode } from '@renderer/lib/skillset-publish-ui'
import { useSkillsetPublishMode } from '@renderer/hooks/use-skillsets'

interface GeneralTabProps {
  name: string
  agentSlug: string
  onNameChange: (name: string) => void
  onDialogClose: () => void
}

export function GeneralTab({ name, agentSlug, onNameChange, onDialogClose }: GeneralTabProps) {
  const [prDialogOpen, setPrDialogOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [forceSyncDialogOpen, setForceSyncDialogOpen] = useState(false)
  const { data: agentPrefs } = useAgentPreferences(agentSlug)
  const updatePrefs = useUpdateAgentPreferences(agentSlug)
  const { data: settings } = useSettings()
  const { data: templateStatus } = useAgentTemplateStatus(agentSlug)
  const refreshTemplateStatus = useRefreshAgentTemplateStatus()
  const forceSyncTemplate = useForceSyncAgentTemplate()
  const updateTemplate = useUpdateAgentTemplate()
  const templateSourceLabel = templateStatus?.sourceLabel || null
  const publishMode = useSkillsetPublishMode(templateStatus?.skillsetId)
  const isPR = isPullRequestPublishMode(publishMode)
  const SubmitIcon = isPR ? GitPullRequest : Send

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="agent-name">Agent Name</Label>
        <Input
          id="agent-name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Enter agent name"
        />
      </div>

      {/* Template Status */}
      {templateStatus && (templateStatus.type !== 'local' || !!templateSourceLabel) && (
        <div className="space-y-2">
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
                  >
                    <SubmitIcon className="h-3 w-3 mr-1" />
                    {getReviewActionLabel(publishMode)}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Session Auto-Delete */}
      <div className="space-y-2">
        <div className="space-y-0.5">
          <Label>Session Auto-Delete</Label>
          <p className="text-xs text-muted-foreground">
            Override the app-wide default for this agent. Starred sessions are preserved.
          </p>
        </div>
        <AgentAutoDeleteSelect
          value={agentPrefs?.autoDeleteInactiveDays}
          appDefault={settings?.app?.autoDeleteInactiveDays}
          onChange={(days) => {
            updatePrefs.mutate({ autoDeleteInactiveDays: days })
          }}
        />
      </div>

      <div className="space-y-2">
        <div className="space-y-0.5">
          <Label>API Log Auto-Delete</Label>
          <p className="text-xs text-muted-foreground">
            Override the app-wide default for this agent. Applies to API and MCP request logs.
          </p>
        </div>
        <AgentApiLogAutoDeleteSelect
          value={agentPrefs?.apiLogAutoDeleteDays}
          appDefault={settings?.app?.apiLogAutoDeleteDays}
          onChange={(days) => {
            updatePrefs.mutate({ apiLogAutoDeleteDays: days })
          }}
        />
      </div>

      {/* Danger Zone */}
      <div className="pt-4 border-t">
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-destructive">Danger Zone</h3>
          <p className="text-sm text-muted-foreground">
            Permanently delete this agent and all its sessions, messages, and data.
          </p>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleteConfirmOpen(true)}
            data-testid="delete-agent-button"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete Agent
          </Button>
          <DeleteAgentConfirmDialog
            agentSlug={agentSlug}
            agentName={name}
            open={deleteConfirmOpen}
            onOpenChange={setDeleteConfirmOpen}
            onDeleted={onDialogClose}
          />
        </div>
      </div>

      {/* PR Dialog */}
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
