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
import { useSelection } from '@renderer/context/selection-context'
import { useNavigate } from '@tanstack/react-router'
import { useStartOnboardingSession } from '@renderer/hooks/use-start-onboarding-session'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiAgent, ApiDiscoverableAgent } from '@shared/lib/types/api'

interface AgentTemplateBrowseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AgentTemplateBrowseDialog({
  open,
  onOpenChange,
}: AgentTemplateBrowseDialogProps) {
  const { data: discoverableAgents } = useDiscoverableAgents()
  const { setAgent } = useSelection()
  const navigate = useNavigate()
  const { track } = useAnalyticsTracking()
  const startOnboardingSession = useStartOnboardingSession()
  const queryClient = useQueryClient()
  const [templateToInstall, setTemplateToInstall] = useState<ApiDiscoverableAgent | null>(null)

  useEffect(() => {
    if (!open) setTemplateToInstall(null)
  }, [open])

  const handleInstalled = useCallback(
    async (agent: ApiAgent, meta: { hasOnboarding?: boolean }) => {
      track('agent_created', { source: 'skillset', num_skills_added_at_creation: 0 })
      await queryClient.refetchQueries({ queryKey: ['agents'] })
      setAgent(agent.slug)
      void navigate({ to: '/agents/$slug', params: { slug: agent.slug } })
      if (meta.hasOnboarding) {
        await startOnboardingSession(agent.slug)
      }
      onOpenChange(false)
    },
    [track, queryClient, setAgent, navigate, startOnboardingSession, onOpenChange],
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
