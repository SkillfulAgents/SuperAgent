/**
 * Chat Integrations Hooks
 *
 * React Query hooks for managing external chat integrations (Telegram, Slack).
 */

import type { ChatIntegration, ChatIntegrationSession } from '@shared/lib/db/schema'
import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export type { ChatIntegration, ChatIntegrationSession }

// ── Query keys ──────────────────────────────────────────────────────────

export const chatIntegrationKeys = {
  all: ['chat-integrations'] as const,
  list: (agentSlug: string | null, status?: string) => ['chat-integrations', agentSlug, status] as const,
  detail: (id: string | null) => ['chat-integration', id] as const,
  status: (id: string | null) => ['chat-integration-status', id] as const,
  sessions: (integrationId: string | null) => ['chat-integration-sessions', integrationId] as const,
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
    refetchInterval: 10_000, // Poll for new sessions (new users DMing the bot)
  })
}

// ── Create mutation ─────────────────────────────────────────────────────

export function useCreateChatIntegration() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (params: {
      agentSlug: string
      provider: 'telegram' | 'slack'
      name?: string
      config: Record<string, unknown>
      showToolCalls?: boolean
    }) => {
      const { agentSlug, ...body } = params
      const res = await apiFetch(`/api/chat-integrations/${agentSlug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: 'Failed to create' }))
        throw new Error((error as { error: string }).error)
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
    mutationFn: async ({
      id,
      ...params
    }: {
      id: string
      name?: string
      config?: Record<string, unknown>
      showToolCalls?: boolean
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

// ── Clear session mutation ──────────────────────────────────────────────

export function useClearChatSession() {
  const queryClient = useQueryClient()

  return useMutation({
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
    mutationFn: async (params: {
      provider: 'telegram' | 'slack'
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
      return data as { valid: boolean; botName?: string; botUsername?: string; team?: string; user?: string }
    },
  })
}
