/**
 * Chat Integrations Hooks
 *
 * React Query hooks for managing external chat integrations (Telegram, Slack).
 */

import type { ChatIntegration, ChatIntegrationSession, ChatIntegrationAccess } from '@shared/lib/db/schema'
import type { ChatProvider } from '@shared/lib/chat-integrations/config-schema'
import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export type { ChatIntegration, ChatIntegrationSession, ChatIntegrationAccess }

export class ChatIntegrationApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly existingIntegrationId?: string
  constructor(message: string, status: number, code?: string, existingIntegrationId?: string) {
    super(message)
    this.name = 'ChatIntegrationApiError'
    this.status = status
    this.code = code
    this.existingIntegrationId = existingIntegrationId
  }
}

// ── Query keys ──────────────────────────────────────────────────────────

export const chatIntegrationKeys = {
  all: ['chat-integrations'] as const,
  list: (agentSlug: string | null, status?: string) => ['chat-integrations', agentSlug, status] as const,
  detail: (id: string | null) => ['chat-integration', id] as const,
  status: (id: string | null) => ['chat-integration-status', id] as const,
  sessions: (integrationId: string | null) => ['chat-integration-sessions', integrationId] as const,
  access: (integrationId: string) => ['chat-integration-access', integrationId] as const,
}

// ── List hooks ──────────────────────────────────────────────────────────

export function useChatIntegrations(agentSlug: string | null, status?: string) {
  return useQuery<ChatIntegration[]>({
    queryKey: chatIntegrationKeys.list(agentSlug, status),
    queryFn: async () => {
      const url = status
        ? `/api/agents/${agentSlug}/chat-integrations?status=${status}`
        : `/api/agents/${agentSlug}/chat-integrations`
      const res = await apiFetch(url)
      if (!res.ok) throw new Error('Failed to fetch chat integrations')
      return res.json()
    },
    enabled: !!agentSlug,
  })
}

// ── Detail hook ─────────────────────────────────────────────────────────

export function useChatIntegration(id: string | null) {
  return useQuery<ChatIntegration>({
    queryKey: chatIntegrationKeys.detail(id),
    queryFn: async () => {
      const res = await apiFetch(`/api/chat-integrations/${id}`)
      if (!res.ok) throw new Error('Failed to fetch chat integration')
      return res.json()
    },
    enabled: !!id,
  })
}

// ── Status hook ─────────────────────────────────────────────────────────

export function useChatIntegrationStatus(id: string | null) {
  return useQuery<{
    status: string
    connected: boolean
    provider: string
  }>({
    queryKey: chatIntegrationKeys.status(id),
    queryFn: async () => {
      const res = await apiFetch(`/api/chat-integrations/${id}/status`)
      if (!res.ok) throw new Error('Failed to fetch status')
      return res.json()
    },
    enabled: !!id,
    refetchInterval: 30_000,
  })
}

// ── Sessions hook ──────────────────────────────────────────────────────

export function useChatIntegrationSessions(integrationId: string | null) {
  return useQuery<ChatIntegrationSession[]>({
    queryKey: chatIntegrationKeys.sessions(integrationId),
    queryFn: async () => {
      const res = await apiFetch(`/api/chat-integrations/${integrationId}/sessions`)
      if (!res.ok) throw new Error('Failed to fetch chat integration sessions')
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

export function useChatIntegrationAccess(integrationId: string | null) {
  return useQuery<ChatIntegrationAccess[]>({
    queryKey: chatIntegrationKeys.access(integrationId ?? ''),
    queryFn: async () => {
      const res = await apiFetch(`/api/chat-integrations/${integrationId}/access`)
      if (!res.ok) throw new Error('Failed to fetch chat integration access')
      return res.json()
    },
    enabled: !!integrationId,
    // Poll for new access requests — same cadence as sessions, no SSE fallback.
    refetchInterval: 20_000,
    refetchIntervalInBackground: false,
  })
}

// ── Create mutation ─────────────────────────────────────────────────────

export function useCreateChatIntegration() {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (params: {
      agentSlug: string
      provider: ChatProvider
      name?: string
      config: Record<string, unknown>
      showToolCalls?: boolean
      sessionTimeout?: number | null
      model?: string | null
      effort?: string | null
    }) => {
      const { agentSlug, ...body } = params
      const res = await apiFetch(`/api/chat-integrations/${agentSlug}`, {
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
        throw new ChatIntegrationApiError(
          payload.error ?? 'Failed to create',
          res.status,
          payload.code,
          payload.existingIntegrationId,
        )
      }
      return res.json() as Promise<ChatIntegration>
    },
    onSuccess: (data) => {
      // Invalidate all list queries for this agent (regardless of status filter)
      queryClient.invalidateQueries({ queryKey: ['chat-integrations', data.agentSlug] })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

// ── Update mutation ─────────────────────────────────────────────────────

export function useUpdateChatIntegration() {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({
      id,
      ...params
    }: {
      id: string
      name?: string
      config?: Record<string, unknown>
      showToolCalls?: boolean
      sessionTimeout?: number | null
      model?: string | null
      effort?: string | null
      status?: 'active' | 'paused'
    }) => {
      const res = await apiFetch(`/api/chat-integrations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      if (!res.ok) throw new Error('Failed to update chat integration')
      return res.json() as Promise<ChatIntegration>
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['chat-integrations', data.agentSlug] })
      queryClient.invalidateQueries({ queryKey: chatIntegrationKeys.detail(data.id) })
      queryClient.invalidateQueries({ queryKey: chatIntegrationKeys.status(data.id) })
    },
  })
}

// ── Delete mutation ─────────────────────────────────────────────────────

export function useDeleteChatIntegration() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, agentSlug }: { id: string; agentSlug: string }) => {
      const res = await apiFetch(`/api/chat-integrations/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete chat integration')
      return { id, agentSlug }
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['chat-integrations', variables.agentSlug] })
      queryClient.invalidateQueries({ queryKey: chatIntegrationKeys.detail(variables.id) })
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
      const res = await apiFetch(`/api/chat-integrations/${integrationId}/access/${accessId}/${verb}`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error(`Failed to ${verb} access`)
      return { integrationId }
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: chatIntegrationKeys.access(variables.integrationId) })
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
      const res = await apiFetch(`/api/chat-integrations/${id}/require-approval`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requireApproval }),
      })
      if (!res.ok) throw new Error('Failed to update require approval')
      return res.json() as Promise<ChatIntegration>
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['chat-integrations', data.agentSlug] })
      queryClient.invalidateQueries({ queryKey: chatIntegrationKeys.detail(data.id) })
      queryClient.invalidateQueries({ queryKey: chatIntegrationKeys.access(data.id) })
    },
  })
}

// ── Clear session mutation ──────────────────────────────────────────────

export function useClearChatSession() {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ integrationId, sessionId }: { integrationId: string; sessionId: string }) => {
      const res = await apiFetch(`/api/chat-integrations/${integrationId}/sessions/${sessionId}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('Failed to clear session')
      return { integrationId }
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: chatIntegrationKeys.sessions(variables.integrationId) })
      queryClient.invalidateQueries({ queryKey: chatIntegrationKeys.detail(variables.integrationId) })
    },
  })
}

// ── Test credentials mutation ───────────────────────────────────────────

export function useTestChatIntegrationCredentials() {
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (params: {
      provider: ChatProvider
      config: Record<string, unknown>
    }) => {
      const res = await apiFetch('/api/chat-integrations/test-credentials', {
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
