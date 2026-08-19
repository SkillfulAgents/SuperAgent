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
import { useNavigate } from '@tanstack/react-router'
import { useStartOnboardingSession } from '@renderer/hooks/use-start-onboarding-session'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiAgentTemplateInstallResult, ApiDiscoverableAgent } from '@shared/lib/types/api'
import { useDraftsStore } from '@renderer/context/drafts-context'
import { completeAgentTemplateHandoff } from '@renderer/lib/agent-template-handoff'

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
  const navigate = useNavigate()
  const { track } = useAnalyticsTracking()
  const startOnboardingSession = useStartOnboardingSession()
  const queryClient = useQueryClient()
  const draftsStore = useDraftsStore()
  const [templateToInstall, setTemplateToInstall] = useState<ApiDiscoverableAgent | null>(null)

  useEffect(() => {
    if (!open) setTemplateToInstall(null)
  }, [open])

  const handleInstalled = useCallback(
    async (agent: ApiAgentTemplateInstallResult) => {
      track('agent_created', {
        source: 'skillset',
        num_skills_added_at_creation: 0,
        has_template_prompt: Boolean(agent.templatePrompt),
      })
      await queryClient.refetchQueries({ queryKey: ['agents'] })
      await completeAgentTemplateHandoff({
        draftsStore,
        agentSlug: agent.slug,
        hasOnboarding: agent.hasOnboarding,
        templatePrompt: agent.templatePrompt,
        openAgent: () => { void navigate({ to: '/agents/$slug', params: { slug: agent.slug } }) },
        startOnboardingSession,
      })
      onOpenChange(false)
      await onInstalled?.()
    },
    [track, queryClient, draftsStore, navigate, startOnboardingSession, onOpenChange, onInstalled],
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
