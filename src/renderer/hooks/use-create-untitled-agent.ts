import { useCallback } from 'react'
import { flushSync } from 'react-dom'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { useCreateAgent } from '@renderer/hooks/use-agents'
import { useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { assignAgentToFolder } from '@renderer/lib/agent-folders'
import { holdAgentRequestsUntilCreated } from '@renderer/lib/api'
import { useNavigate } from '@tanstack/react-router'
import { useNavTransient } from '@renderer/context/nav-transient-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { randomAgentAvatar } from '@shared/lib/types/agent-avatar'
import type { ApiAgent } from '@shared/lib/types/api'
import { displaySlug, randomAgentId } from '@shared/lib/utils/agent-id'

export const UNTITLED_AGENT_NAME = 'Untitled'

/** Where the create was started, for `agent_created`'s `surface`. */
export type CreateUntitledAgentSurface = 'nav' | 'section_plus' | 'home' | 'app_menu'

export interface CreateUntitledAgentOptions {
  surface: CreateUntitledAgentSurface
  /**
   * The left-nav folder to file the new agent into. Omitted (or the default
   * folder) leaves it unfiled, the way the nav's own "New Agent" does.
   */
  folderId?: string
}

/**
 * Creates an "Untitled" agent and opens it at once. The id and avatar are chosen here, so the
 * agent's page shows before the host has answered (on some hosts a create takes seconds while the
 * agent's runtime first starts). Until the create answers, every request about the agent waits for
 * it (see `holdAgentRequestsUntilCreated`). A create that fails takes the agent away again.
 */
export function useCreateUntitledAgent() {
  const createAgent = useCreateAgent()
  const updateSettings = useUpdateUserSettings()
  const queryClient = useQueryClient()
  // Morph tag lives in NavTransientContext; set it BEFORE navigate so
  // AgentHome's first-mount initializer reads it and plays the intro once.
  const { setJustCreatedSlug } = useNavTransient()
  const navigate = useNavigate()
  const { track } = useAnalyticsTracking()

  const createUntitledAgent = useCallback(async (options: CreateUntitledAgentOptions) => {
    const id = randomAgentId()
    const avatar = randomAgentAvatar()
    const pending: ApiAgent = {
      slug: id,
      displaySlug: displaySlug(UNTITLED_AGENT_NAME, id),
      name: UNTITLED_AGENT_NAME,
      avatar,
      createdAt: new Date(),
      status: 'stopped',
      containerPort: null,
    }
    // Both keys the agent's page reads it by (see useCreateAgent), and the list the nav shows.
    queryClient.setQueryData(['agents', pending.slug], pending)
    queryClient.setQueryData(['agents', pending.displaySlug], pending)
    queryClient.setQueryData<ApiAgent[]>(['agents'], (agents) => agents && [pending, ...agents])

    const creation = createAgent.mutateAsync({ name: UNTITLED_AGENT_NAME, id, avatar })
    holdAgentRequestsUntilCreated(id, creation)

    // Morph tag keys on the canonical id (AgentHome compares against agent.slug);
    // navigate with the pretty display slug so the URL reflects the name.
    //
    // Commit the tag SYNCHRONOUSLY before navigating: `navigate` renders the
    // destination route (mounting AgentHome) within the same tick, and AgentHome
    // reads `justCreatedSlug` once in a mount-time initializer. Without flushSync
    // the router's synchronous render runs before React commits this context
    // update, so AgentHome captures the pre-set `null` and the intro never plays.
    flushSync(() => setJustCreatedSlug(id))
    void navigate({ to: '/agents/$slug', params: { slug: pending.displaySlug } })

    let agent: ApiAgent
    try {
      agent = await creation
    } catch (error) {
      console.error('Failed to create untitled agent:', error)
      queryClient.removeQueries({ queryKey: ['agents', pending.slug], exact: true })
      queryClient.removeQueries({ queryKey: ['agents', pending.displaySlug], exact: true })
      void queryClient.invalidateQueries({ queryKey: ['agents'], exact: true })
      toast.error('Failed to create agent', {
        description: error instanceof Error ? error.message : 'Please try again.',
      })
      void navigate({ to: '/' })
      return null
    }

    track('agent_created', {
      source: 'new',
      surface: options.surface,
      num_skills_added_at_creation: 0,
    })

    if (options.folderId) {
      const folderId = options.folderId
      try {
        // Resolve the assignment against the latest settings when the serialized write runs.
        await updateSettings.mutateAsync((current) => ({
          agentFolderAssignments: assignAgentToFolder(
            current.agentFolderAssignments,
            agent.slug,
            folderId
          ),
        }))
      } catch {
        // Creation succeeded. Explain where to find the agent instead of inviting
        // a retry that would create a duplicate.
        toast.error('Agent created, but could not add it to the section', {
          description: 'You can find it in Your Agents and move it from there.',
        })
      }
    }

    return agent
  }, [createAgent, updateSettings, queryClient, setJustCreatedSlug, navigate, track])

  return {
    createUntitledAgent,
    isPending: createAgent.isPending || updateSettings.isPending,
  }
}
