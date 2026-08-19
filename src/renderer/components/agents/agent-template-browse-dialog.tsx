import { useCallback, useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { AgentTemplateBrowseContent } from './agent-template-browse-content'
import { TemplateInstallDialog } from './template-install-dialog'
import { useDiscoverableAgents } from '@renderer/hooks/use-agent-templates'
import { useCompleteTemplateInstall } from '@renderer/hooks/use-complete-template-install'
import type { ApiAgentTemplateInstallResult, ApiDiscoverableAgent } from '@shared/lib/types/api'

interface AgentTemplateBrowseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fires after the selected template has been installed and opened. */
  onInstalled?: () => void | Promise<void>
}

export function AgentTemplateBrowseDialog({
  open,
  onOpenChange,
  onInstalled,
}: AgentTemplateBrowseDialogProps) {
  const { data: discoverableAgents } = useDiscoverableAgents()
  const completeInstall = useCompleteTemplateInstall()
  const [templateToInstall, setTemplateToInstall] = useState<ApiDiscoverableAgent | null>(null)

  useEffect(() => {
    if (!open) setTemplateToInstall(null)
  }, [open])

  const handleInstalled = useCallback(
    async (agent: ApiAgentTemplateInstallResult) => {
      await completeInstall(agent)
      onOpenChange(false)
      await onInstalled?.()
    },
    [completeInstall, onOpenChange, onInstalled],
  )

  const hasTemplates = discoverableAgents && discoverableAgents.length > 0

  return (
    <>
      <Dialog open={open && !templateToInstall} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl" onOpenAutoFocus={(e) => e.preventDefault()} data-testid="agent-template-browse-dialog">
          <DialogHeader>
            <DialogTitle>Agent Marketplace</DialogTitle>
            <DialogDescription className="sr-only">Browse and install agent templates from your connected skillsets</DialogDescription>
          </DialogHeader>

          {hasTemplates ? (
            <AgentTemplateBrowseContent
              discoverableAgents={discoverableAgents}
              onSelect={setTemplateToInstall}
              minHeight="60vh"
            />
          ) : (
            <p className="text-sm text-muted-foreground text-center py-12">
              No agent templates available. Connect a skillset with agent templates to get started.
            </p>
          )}
        </DialogContent>
      </Dialog>

      <TemplateInstallDialog
        template={templateToInstall}
        onClose={() => setTemplateToInstall(null)}
        onInstalled={handleInstalled}
      />
    </>
  )
}
