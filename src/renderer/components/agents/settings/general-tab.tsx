
import { useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
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
  AlertDialogTrigger,
} from '@renderer/components/ui/alert-dialog'
import { useDeleteAgent } from '@renderer/hooks/use-agents'
import { useSelection } from '@renderer/context/selection-context'
import {
  useAgentTemplateStatus,
  useUpdateAgentTemplate,
  useExportAgentTemplate,
} from '@renderer/hooks/use-agent-templates'
import { StatusBadge } from '@renderer/components/agents/status-badge'
import { AgentTemplatePRDialog } from '@renderer/components/agents/agent-template-pr-dialog'
import { AgentTemplatePublishDialog } from '@renderer/components/agents/agent-template-publish-dialog'
import { Trash2, Download, RefreshCw, GitPullRequest, Upload, Loader2 } from 'lucide-react'

interface GeneralTabProps {
  name: string
  agentSlug: string
  onNameChange: (name: string) => void
  onDialogClose: () => void
}

export function GeneralTab({ name, agentSlug, onNameChange, onDialogClose }: GeneralTabProps) {
  const [isDeleting, setIsDeleting] = useState(false)
  const [prDialogOpen, setPrDialogOpen] = useState(false)
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const deleteAgent = useDeleteAgent()
  const { handleAgentDeleted } = useSelection()
  const { data: templateStatus } = useAgentTemplateStatus(agentSlug)
  const updateTemplate = useUpdateAgentTemplate()
  const exportTemplate = useExportAgentTemplate()

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      await deleteAgent.mutateAsync(agentSlug)
      onDialogClose()
      handleAgentDeleted(agentSlug)
    } catch (error) {
      console.error('Failed to delete agent:', error)
    } finally {
      setIsDeleting(false)
    }
  }

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
      {templateStatus && templateStatus.type !== 'local' && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Template Status</h3>
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={templateStatus} />
            {templateStatus.skillsetName && (
              <span className="text-xs text-muted-foreground">
                from {templateStatus.skillsetName}
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
            {templateStatus.type === 'locally_modified' && !templateStatus.openPrUrl && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPrDialogOpen(true)}
              >
                <GitPullRequest className="h-3 w-3 mr-1" />
                Open PR
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Export / Publish */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Template</h3>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => exportTemplate.mutate({ agentSlug, agentName: name })}
            disabled={exportTemplate.isPending}
          >
            {exportTemplate.isPending ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <Download className="h-3 w-3 mr-1" />
            )}
            Export as Template
          </Button>
          {templateStatus?.type === 'local' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPublishDialogOpen(true)}
            >
              <Upload className="h-3 w-3 mr-1" />
              Publish to Skillset
            </Button>
          )}
        </div>
      </div>

      {/* Danger Zone */}
      <div className="pt-4 border-t">
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-destructive">Danger Zone</h3>
          <p className="text-sm text-muted-foreground">
            Permanently delete this agent and all its sessions, messages, and data.
          </p>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" data-testid="delete-agent-button">
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Agent
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Agent</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete &quot;{name}&quot;? This will permanently delete
                  the agent and all its sessions, messages, and data. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  data-testid="confirm-button"
                >
                  {isDeleting ? 'Deleting...' : 'Delete'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* PR Dialog */}
      <AgentTemplatePRDialog
        open={prDialogOpen}
        onOpenChange={setPrDialogOpen}
        agentSlug={agentSlug}
      />

      {/* Publish Dialog */}
      <AgentTemplatePublishDialog
        open={publishDialogOpen}
        onOpenChange={setPublishDialogOpen}
        agentSlug={agentSlug}
      />
    </div>
  )
}
