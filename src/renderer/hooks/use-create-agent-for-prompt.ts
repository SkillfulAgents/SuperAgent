import { useCallback } from 'react'
import { useCreateAgent, useUpdateAgent } from '@renderer/hooks/use-agents'
import { deriveAgentName } from '@renderer/lib/derive-agent-name'
import type { ApiAgent } from '@shared/lib/types/api'

/**
 * Makes the agent a first message is about to be dispatched to, named from
 * that message. With `warmSlug`, an already pre-created Untitled agent is
 * named instead of creating another.
 */
export function useCreateAgentForPrompt(): (prompt: string, warmSlug?: string | null) => Promise<ApiAgent> {
  const { mutateAsync: createAgent } = useCreateAgent()
  const { mutateAsync: updateAgent } = useUpdateAgent()
  return useCallback(async (prompt, warmSlug) => {
    const name = await deriveAgentName(prompt)
    return warmSlug ? updateAgent({ slug: warmSlug, name }) : createAgent({ name })
  }, [createAgent, updateAgent])
}
