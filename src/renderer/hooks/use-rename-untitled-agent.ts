import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { apiFetch } from '@renderer/lib/api'
import { deriveAgentName } from '@renderer/lib/derive-agent-name'
import type { ApiAgent } from '@shared/lib/types/api'

/**
 * Derives an agent name from the given prompt and PUTs it to the server,
 * then invalidates the agents queries.
 *
 * Intended for the post-submit rename of a fresh Untitled agent — the
 * caller typically fires this after navigating to the new session, so
 * the mutation may outlive the component that mounted it.
 */
export function useRenameUntitledAgent() {
  const queryClient = useQueryClient()
  return useMutation<ApiAgent | null, Error, { slug: string; prompt: string }>({
    mutationFn: async ({ slug, prompt }) => {
      const name = await deriveAgentName(prompt)
      if (!name) return null
      const res = await apiFetch(`/api/agents/${slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error('Failed to rename agent')
      return res.json() as Promise<ApiAgent>
    },
    onSuccess: (_agent, variables) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['agents', variables.slug] })
    },
    onError: (error) => {
      console.error('Failed to rename untitled agent:', error)
      toast.error('Could not auto-name agent', {
        description: error instanceof Error ? error.message : 'The agent will stay as "Untitled" — you can rename it from the agent home page.',
      })
    },
  })
}
