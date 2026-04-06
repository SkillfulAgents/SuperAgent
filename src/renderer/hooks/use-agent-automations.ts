/**
 * Agent Automations — shared hooks for automation entities
 * (scheduled tasks, webhook triggers).
 *
 * These factories eliminate duplication between use-scheduled-tasks.ts
 * and use-webhook-triggers.ts, which follow identical fetch / cancel /
 * list-sessions patterns.
 */

import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutomationSessionInfo {
  id: string
  name: string
  createdAt: string
  lastActivityAt?: string
  messageCount?: number
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Fetch all automations of a given type for an agent.
 */
export function useAutomationList<T>(
  type: 'scheduled-tasks' | 'webhook-triggers',
  agentSlug: string | null,
  status?: string,
  options?: { refetchInterval?: number },
) {
  return useQuery<T[]>({
    queryKey: [type, agentSlug, status],
    queryFn: async () => {
      const url = status
        ? `/api/agents/${agentSlug}/${type}?status=${status}`
        : `/api/agents/${agentSlug}/${type}`
      const res = await apiFetch(url)
      if (!res.ok) throw new Error(`Failed to fetch ${type.replace('-', ' ')}`)
      return res.json()
    },
    enabled: !!agentSlug,
    ...options,
  })
}

/**
 * Fetch a single automation entity by ID.
 */
export function useAutomationDetail<T>(
  type: 'scheduled-tasks' | 'webhook-triggers',
  id: string | null,
  options?: { refetchInterval?: number },
) {
  // Query key uses singular form: 'scheduled-task' / 'webhook-trigger'
  const singularKey = type.replace(/s$/, '')
  return useQuery<T>({
    queryKey: [singularKey, id],
    queryFn: async () => {
      const res = await apiFetch(`/api/${type}/${id}`)
      if (!res.ok) throw new Error(`Failed to fetch ${singularKey.replace('-', ' ')}`)
      return res.json()
    },
    enabled: !!id,
    ...options,
  })
}

/**
 * Cancel (DELETE) an automation entity.
 */
export function useCancelAutomation(type: 'scheduled-tasks' | 'webhook-triggers') {
  const queryClient = useQueryClient()
  const singularKey = type.replace(/s$/, '')

  return useMutation({
    mutationFn: async ({ id, agentSlug }: { id: string; agentSlug: string }) => {
      const res = await apiFetch(`/api/${type}/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`Failed to cancel ${singularKey.replace('-', ' ')}`)
      return { id, agentSlug }
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: [type, variables.agentSlug] })
      queryClient.invalidateQueries({ queryKey: [singularKey, variables.id] })
    },
  })
}

/**
 * Fetch sessions created by an automation entity.
 */
export function useAutomationSessions(
  type: 'scheduled-tasks' | 'webhook-triggers',
  id: string | null,
) {
  const singularKey = type.replace(/s$/, '')
  return useQuery<AutomationSessionInfo[]>({
    queryKey: [`${singularKey}-sessions`, id],
    queryFn: async () => {
      const res = await apiFetch(`/api/${type}/${id}/sessions`)
      if (!res.ok) throw new Error('Failed to fetch sessions')
      return res.json()
    },
    enabled: !!id,
  })
}
