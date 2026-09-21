/**
 * Agent Integration Hooks
 *
 * React Query hooks for managing external agent integrations.
 */

import type { AgentIntegrationSession, ChatIntegrationAccess } from '@shared/lib/db/schema'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { isSettling } from '@shared/lib/agent-integrations/presentation'
import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export type { AgentIntegrationSession, ChatIntegrationAccess }
export type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'

/** A list row plus the live transport state the list route computes, so the
 *  agent-home tag can derive its state from the same `(status, connected)` the
 *  connector page uses. */
export type AgentIntegrationListItem = PublicAgentIntegration & { connected: boolean }

export class AgentIntegrationApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly existingIntegrationId?: string
  constructor(message: string, status: number, code?: string, existingIntegrationId?: string) {
    super(message)
    this.name = 'AgentIntegrationApiError'
    this.status = status
    this.code = code
    this.existingIntegrationId = existingIntegrationId
  }
}

// ── Query keys ──────────────────────────────────────────────────────────

export const agentIntegrationKeys = {
  all: ['chat-integrations'] as const,
  lists: (agentSlug: string | null) => [...agentIntegrationKeys.all, agentSlug] as const,
  list: (agentSlug: string | null, status?: string) => [...agentIntegrationKeys.lists(agentSlug), status] as const,
  detail: (id: string | null) => ['chat-integration', id] as const,
  status: (id: string | null) => ['chat-integration-status', id] as const,
  sessions: (integrationId: string | null) => ['chat-integration-sessions', integrationId] as const,
  access: (integrationId: string) => ['chat-integration-access', integrationId] as const,
}

// ── List hooks ──────────────────────────────────────────────────────────

export function useAgentIntegrations(agentSlug: string | null, status?: string) {
  return useQuery<AgentIntegrationListItem[]>({
    queryKey: agentIntegrationKeys.list(agentSlug, status),
    queryFn: async () => {
      const url = status
        ? `/api/agent-integrations/agents/${agentSlug}?status=${status}`
        : `/api/agent-integrations/agents/${agentSlug}`
      const res = await apiFetch(url)
      if (!res.ok) throw new Error('Failed to fetch agent integrations')
      return res.json()
    },
    enabled: !!agentSlug,
    // Keep the live `connected` fresh so the home tag tracks the wire like the
    // connector card does (same cadence as useAgentIntegrationStatus): poll fast
    // while any integration is still connecting, idle once all are settled. Only
    // while foregrounded - a stuck "Connecting…" shouldn't churn a backgrounded tab.
    refetchInterval: (query) =>
      query.state.data?.some((i) => isSettling(i.status, i.connected)) ? 3_000 : 30_000,
    refetchIntervalInBackground: false,
  })
}

// ── Detail hook ─────────────────────────────────────────────────────────

export function useAgentIntegration(id: string | null) {
  return useQuery<PublicAgentIntegration>({
    queryKey: agentIntegrationKeys.detail(id),
    queryFn: async () => {
      const res = await apiFetch(`/api/agent-integrations/${id}`)
      if (!res.ok) throw new Error('Failed to fetch agent integration')
      return res.json()
    },
    enabled: !!id,
    // OAuth completes in another window. Poll quickly only during its live
    // authorization window; providers opt in to any settled health polling.
    refetchInterval: query => (query.state.data?.authorizationPendingUntil ?? 0) > Date.now() ? 2500 : query.state.data?.refreshIntervalMs ?? false,
    refetchIntervalInBackground: false,
  })
}

// ── Status hook ─────────────────────────────────────────────────────────

export function useAgentIntegrationStatus(id: string | null) {
  return useQuery<{
    status: string
    connected: boolean
    provider: string
  }>({
    queryKey: agentIntegrationKeys.status(id),
    queryFn: async () => {
      const res = await apiFetch(`/api/agent-integrations/${id}/status`)
      if (!res.ok) throw new Error('Failed to fetch status')
      return res.json()
    },
    enabled: !!id,
    // "Connecting…" (active but the wire isn't up yet) is a transient state the
    // transport leaves within a second or two of a (re)connect. Poll fast while
    // it's unsettled so the card converges to "Listening" promptly instead of
    // sitting on a stale `connected:false` for a full idle interval; back off to
    // the idle cadence once it's up (or paused/errored — settled states). Only
    // while foregrounded so a stuck "Connecting…" can't churn a backgrounded tab.
    refetchInterval: (query) => {
      const data = query.state.data
      return data && isSettling(data.status, data.connected) ? 3_000 : 30_000
    },
    refetchIntervalInBackground: false,
  })
}

// ── Sessions hook ──────────────────────────────────────────────────────

export function useAgentIntegrationSessions(integrationId: string | null) {
  return useQuery<AgentIntegrationSession[]>({
    queryKey: agentIntegrationKeys.sessions(integrationId),
    queryFn: async () => {
      const res = await apiFetch(`/api/agent-integrations/${integrationId}/sessions`)
      if (!res.ok) throw new Error('Failed to fetch agent integration sessions')
      return res.json()
    },
    enabled: !!integrationId,
    // Poll for new sessions (new users DMing the bot) — these have no SSE
    // fallback, so keep polling, just less aggressively, and not while backgrounded.
    // TODO: conservative first step down from the original 10s; can be raised
    // further (e.g. 60s) once we've confirmed new-session latency is acceptable.
    refetchInterval: 20_000,
    refetchIntervalInBackground: false,
  })
}

// ── Access hook ────────────────────────────────────────────────────────

export function useAgentIntegrationAccess(integrationId: string | null, enabled = true) {
  return useQuery<ChatIntegrationAccess[]>({
    queryKey: agentIntegrationKeys.access(integrationId ?? ''),
    queryFn: async () => {
      const res = await apiFetch(`/api/agent-integrations/${integrationId}/access`)
      if (!res.ok) throw new Error('Failed to fetch agent integration access')
      return res.json()
    },
    // The /access route is owner-gated; callers pass enabled=false for non-owners
    // (and non-Telegram providers) so viewers don't trigger a 403.
    enabled: !!integrationId && enabled,
    // Poll for new access requests — same cadence as sessions, no SSE fallback.
    refetchInterval: 20_000,
    refetchIntervalInBackground: false,
  })
}

// ── Create mutation ─────────────────────────────────────────────────────

export function useCreateAgentIntegration() {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (params: {
      agentSlug: string
      provider: string
      name?: string
      config: Record<string, unknown>
      showToolCalls?: boolean
      sessionTimeout?: number | null
      model?: string | null
      effort?: string | null
      speed?: string | null
    }) => {
      const { agentSlug, ...body } = params
      const res = await apiFetch(`/api/agent-integrations/agents/${agentSlug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => ({ error: 'Failed to create' })) as {
          error?: string
          code?: string
          existingIntegrationId?: string
        }
        throw new AgentIntegrationApiError(
          payload.error ?? 'Failed to create',
          res.status,
          payload.code,
          payload.existingIntegrationId,
        )
      }
      return res.json() as Promise<PublicAgentIntegration>
    },
    onSuccess: (data) => {
      // Invalidate all list queries for this agent (regardless of status filter)
      queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.lists(data.agentSlug) })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

// ── Update mutation ─────────────────────────────────────────────────────

export function useUpdateAgentIntegration() {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({
      id,
      ...params
    }: {
      id: string
      name?: string
      settings?: Record<string, unknown>
      config?: Record<string, unknown>
      showToolCalls?: boolean
      sessionTimeout?: number | null
      model?: string | null
      effort?: string | null
      speed?: string | null
      status?: 'active' | 'paused'
    }) => {
      const res = await apiFetch(`/api/agent-integrations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      if (!res.ok) throw new Error('Failed to update agent integration')
      return res.json() as Promise<PublicAgentIntegration>
    },
    onSuccess: (data) => {
      queryClient.setQueryData(agentIntegrationKeys.detail(data.id), data)
      queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.lists(data.agentSlug) })
      queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.detail(data.id) })
      queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.status(data.id) })
    },
  })
}

// ── Delete mutation ─────────────────────────────────────────────────────

export function useDeleteAgentIntegration() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, agentSlug }: { id: string; agentSlug: string }) => {
      const res = await apiFetch(`/api/agent-integrations/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete agent integration')
      return { id, agentSlug }
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.lists(variables.agentSlug) })
      queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.detail(variables.id) })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

// ── Access mutations ────────────────────────────────────────────────────

type ChatAccessVerb = 'approve' | 'deny' | 'revoke'

// One mutation primitive for all three access decisions — a new verb is added,
// not threaded through three near-identical hooks. Mirrors the server-side
// `accessActions` verb loop. Mutations carry `accessId` so callers can scope
// per-row pending UI to the row being acted on.
function useChatAccessAction(verb: ChatAccessVerb) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ integrationId, accessId }: { integrationId: string; accessId: string }) => {
      const res = await apiFetch(`/api/agent-integrations/${integrationId}/access/${accessId}/${verb}`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error(`Failed to ${verb} access`)
      return { integrationId }
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.access(variables.integrationId) })
    },
  })
}

export const useApproveChatAccess = () => useChatAccessAction('approve')
export const useDenyChatAccess = () => useChatAccessAction('deny')
export const useRevokeChatAccess = () => useChatAccessAction('revoke')

// Toggle the allowlist on/off — hits the dedicated owner-only endpoint so the
// security-sensitive "make public" flip is gated separately from general edits.
export function useSetRequireApproval() {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ id, requireApproval }: { id: string; requireApproval: boolean }) => {
      const res = await apiFetch(`/api/agent-integrations/${id}/require-approval`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requireApproval }),
      })
      if (!res.ok) throw new Error('Failed to update require approval')
      return res.json() as Promise<PublicAgentIntegration>
    },
    onSuccess: (data) => {
      queryClient.setQueryData(agentIntegrationKeys.detail(data.id), data)
      queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.lists(data.agentSlug) })
      queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.detail(data.id) })
      queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.access(data.id) })
    },
  })
}

// ── Clear session mutation ──────────────────────────────────────────────

export function useClearChatSession() {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ integrationId, sessionId }: { integrationId: string; sessionId: string }) => {
      const res = await apiFetch(`/api/agent-integrations/${integrationId}/sessions/${sessionId}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('Failed to clear session')
      return { integrationId }
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.sessions(variables.integrationId) })
      queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.detail(variables.integrationId) })
    },
  })
}

// ── Test credentials mutation ───────────────────────────────────────────

export function useTestAgentIntegrationCredentials() {
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (params: {
      provider: string
      config: Record<string, unknown>
    }) => {
      const res = await apiFetch('/api/agent-integrations/test-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error((data as { error: string }).error || 'Invalid credentials')
      }
      return data as { valid: boolean; botName?: string; botUsername?: string; team?: string; user?: string; phoneNumber?: string; token?: string }
    },
  })
}
