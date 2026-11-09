import { useCallback } from 'react'
import { useCreateAgent, useUpdateAgent, useUpdateAgentAvatar } from '@renderer/hooks/use-agents'
import { deriveAgentName } from '@renderer/lib/derive-agent-name'
import type { ApiAgent } from '@shared/lib/types/api'
import type { AgentAvatar } from '@shared/lib/types/agent-avatar'

/** The name and orb chosen on the create page's first step. */
export interface ChosenAgentIdentity {
  name: string
  avatar: AgentAvatar
}

/**
 * Makes the agent a first message is about to be dispatched to. Named from
 * that message unless `identity` carries a name the user chose; the message
 * still supplies the description. With `warmSlug`, an already pre-created
 * Untitled agent is named instead of creating another.
 */
export function useCreateAgentForPrompt(): (
  prompt: string,
  warmSlug?: string | null,
  identity?: ChosenAgentIdentity | null,
) => Promise<ApiAgent> {
  const { mutateAsync: createAgent } = useCreateAgent()
  const { mutateAsync: updateAgent } = useUpdateAgent()
  const { mutateAsync: updateAvatar } = useUpdateAgentAvatar()
  return useCallback(async (prompt, warmSlug, identity) => {
    const derived = await deriveAgentName(prompt)
    const name = identity?.name ?? derived.name
    const { description } = derived
    if (!warmSlug) return createAgent({ name, description, avatar: identity?.avatar })
    const agent = await updateAgent({ slug: warmSlug, name, description })
    if (!identity) return agent
    // The warm agent was drawn a random orb when it was pre-created.
    const avatar = await updateAvatar({ slug: warmSlug, avatar: identity.avatar })
    return { ...agent, avatar }
  }, [createAgent, updateAgent, updateAvatar])
}
