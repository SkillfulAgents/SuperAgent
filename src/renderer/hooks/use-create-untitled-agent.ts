import { useCallback } from 'react'
import { toast } from 'sonner'
import { useCreateAgent } from '@renderer/hooks/use-agents'
import { useNavigate } from '@tanstack/react-router'
import { useSelection } from '@renderer/context/selection-context'
import { useNavTransient } from '@renderer/context/nav-transient-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'

export const UNTITLED_AGENT_NAME = 'Untitled'

export function useCreateUntitledAgent() {
  const createAgent = useCreateAgent()
  const { setAgent } = useSelection()
  // Morph tag lives in NavTransientContext now (R10); set it BEFORE navigate so
  // AgentHome's first-mount initializer reads it and plays the intro once (§8.5).
  const { setJustCreatedSlug } = useNavTransient()
  const navigate = useNavigate()
  const { track } = useAnalyticsTracking()

  const createUntitledAgent = useCallback(async () => {
    try {
      const agent = await createAgent.mutateAsync({ name: UNTITLED_AGENT_NAME })
      track('agent_created', { source: 'new', num_skills_added_at_creation: 0 })

      setJustCreatedSlug(agent.slug)
      setAgent(agent.slug)
      void navigate({ to: '/agents/$slug', params: { slug: agent.slug } })

      return agent
    } catch (error) {
      console.error('Failed to create untitled agent:', error)
      toast.error('Failed to create agent', {
        description: error instanceof Error ? error.message : 'Please try again.',
      })
      return null
    }
  }, [createAgent, setAgent, setJustCreatedSlug, navigate, track])

  return {
    createUntitledAgent,
    isPending: createAgent.isPending,
  }
}
