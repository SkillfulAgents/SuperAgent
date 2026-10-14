import { useCallback } from 'react'
import { flushSync } from 'react-dom'
import { toast } from 'sonner'
import { useCreateAgent } from '@renderer/hooks/use-agents'
import { useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { assignAgentToFolder } from '@renderer/lib/agent-folders'
import { useNavigate } from '@tanstack/react-router'
import { useNavTransient } from '@renderer/context/nav-transient-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'

export const UNTITLED_AGENT_NAME = 'Untitled'

export interface CreateUntitledAgentOptions {
  /**
   * The left-nav folder to file the new agent into. Omitted (or the default
   * folder) leaves it unfiled, the way the nav's own "New Agent" does.
   */
  folderId?: string
}

export function useCreateUntitledAgent() {
  const createAgent = useCreateAgent()
  const updateSettings = useUpdateUserSettings()
  // Morph tag lives in NavTransientContext; set it BEFORE navigate so
  // AgentHome's first-mount initializer reads it and plays the intro once.
  const { setJustCreatedSlug } = useNavTransient()
  const navigate = useNavigate()
  const { track } = useAnalyticsTracking()

  const createUntitledAgent = useCallback(async (options?: CreateUntitledAgentOptions) => {
    try {
      const agent = await createAgent.mutateAsync({ name: UNTITLED_AGENT_NAME })
      track('agent_created', {
        source: 'new',
        surface: options?.folderId ? 'section_plus' : 'nav',
        num_skills_added_at_creation: 0,
      })

      // Wait for the filing before navigating. Resolve the assignment against
      // the latest settings when the serialized write runs.
      if (options?.folderId) {
        const folderId = options.folderId
        try {
          await updateSettings.mutateAsync((current) => ({
            agentFolderAssignments: assignAgentToFolder(
              current.agentFolderAssignments,
              agent.slug,
              folderId
            ),
          }))
        } catch {
          // Creation succeeded. Open the agent even if its per-user filing
          // failed, and explain where to find it instead of inviting a retry
          // that would create a duplicate.
          toast.error('Agent created, but could not add it to the section', {
            description: 'You can find it in Your Agents and move it from there.',
          })
        }
      }

      // Morph tag keys on the canonical id (AgentHome compares against agent.slug);
      // navigate with the pretty display slug so the URL reflects the name.
      //
      // Commit the tag SYNCHRONOUSLY before navigating: `navigate` renders the
      // destination route (mounting AgentHome) within the same tick, and AgentHome
      // reads `justCreatedSlug` once in a mount-time initializer. Without flushSync
      // the router's synchronous render runs before React commits this context
      // update, so AgentHome captures the pre-set `null` and the intro never plays.
      flushSync(() => setJustCreatedSlug(agent.slug))
      void navigate({ to: '/agents/$slug', params: { slug: agent.displaySlug } })

      return agent
    } catch (error) {
      console.error('Failed to create untitled agent:', error)
      toast.error('Failed to create agent', {
        description: error instanceof Error ? error.message : 'Please try again.',
      })
      return null
    }
  }, [createAgent, updateSettings, setJustCreatedSlug, navigate, track])

  return {
    createUntitledAgent,
    isPending: createAgent.isPending || updateSettings.isPending,
  }
}
