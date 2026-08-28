import { useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useStartOnboardingSession } from '@renderer/hooks/use-start-onboarding-session'
import { useDraftsStore } from '@renderer/context/drafts-context'
import { completeAgentTemplateHandoff } from '@renderer/lib/agent-template-handoff'
import type { ApiAgentTemplateInstallResult } from '@shared/lib/types/api'

/**
 * The one post-install path for a marketplace template: track, refresh the
 * agent list, then hand off (seed the template prompt or start onboarding)
 * and open the new agent. ONE definition shared by every Explore surface so
 * the flows can't drift.
 */
export function useCompleteTemplateInstall() {
  const navigate = useNavigate()
  const { track } = useAnalyticsTracking()
  const startOnboardingSession = useStartOnboardingSession()
  const queryClient = useQueryClient()
  const draftsStore = useDraftsStore()

  return useCallback(
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
        onboardingFirstPrompt: agent.onboardingFirstPrompt,
        openAgent: () => { void navigate({ to: '/agents/$slug', params: { slug: agent.slug } }) },
        startOnboardingSession,
      })
    },
    [track, queryClient, draftsStore, navigate, startOnboardingSession],
  )
}
