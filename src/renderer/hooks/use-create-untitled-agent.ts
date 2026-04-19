import { useCallback } from 'react'
import { useCreateAgent } from '@renderer/hooks/use-agents'
import { useSelection } from '@renderer/context/selection-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'

export const UNTITLED_AGENT_NAME = 'Untitled'

/**
 * Immediately creates an Untitled agent and selects it. Replaces the old
 * "open the create-agent modal" flow — the user lands on the agent's home
 * page where the composer + creation aids handle the rest.
 */
export function useCreateUntitledAgent() {
  const createAgent = useCreateAgent()
  const { selectAgent } = useSelection()
  const { track } = useAnalyticsTracking()

  const createUntitledAgent = useCallback(async () => {
    try {
      const agent = await createAgent.mutateAsync({ name: UNTITLED_AGENT_NAME })
      track('agent_created', { source: 'new', num_skills_added_at_creation: 0 })
      selectAgent(agent.slug)
      return agent
    } catch (error) {
      console.error('Failed to create untitled agent:', error)
      return null
    }
  }, [createAgent, selectAgent, track])

  return {
    createUntitledAgent,
    isPending: createAgent.isPending,
  }
}
