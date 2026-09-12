import { useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useAgents, type ApiAgent } from '@renderer/hooks/use-agents'

export type RunningAgentsAction = 'stop' | 'restart'

export interface RunningAgentItem {
  id: string
  name: string
}

interface RunningAgentsActionResponse {
  success: boolean
  agentIds: string[]
}

/** Resolve the authoritative running IDs from settings to user-facing names. */
export function useRunningAgents(runningAgentIds?: string[]): RunningAgentItem[] {
  const { data: agents = [] } = useAgents()

  return useMemo(() => {
    const ids = runningAgentIds ?? agents
      .filter((agent) => agent.status === 'running')
      .map((agent) => agent.slug)
    const agentsById = new Map<string, ApiAgent>(agents.map((agent) => [agent.slug, agent]))

    return ids.map((id) => ({
      id,
      name: agentsById.get(id)?.name || id,
    }))
  }, [agents, runningAgentIds])
}

/** Shared stop/restart mutation used by settings warnings. */
export function useRunningAgentsAction(action: RunningAgentsAction) {
  const queryClient = useQueryClient()

  return useMutation<RunningAgentsActionResponse, Error>({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async () => {
      const res = await apiFetch(`/api/settings/running-agents/${action}`, { method: 'POST' })
      const body = await res.json().catch(() => ({})) as Partial<RunningAgentsActionResponse> & { error?: string }
      if (!res.ok) throw new Error(body.error || `Failed to ${action} running agents`)
      return body as RunningAgentsActionResponse
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
  })
}
