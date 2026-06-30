import { apiFetch } from '@renderer/lib/api'

import { useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export interface RemoteMcpServer {
  id: string
  name: string
  url: string
  authType: 'none' | 'oauth' | 'bearer'
  status: 'active' | 'error' | 'auth_required'
  errorMessage: string | null
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
  toolsDiscoveredAt: string | null
  createdAt: string
  updatedAt: string
}

export interface AgentRemoteMcp extends RemoteMcpServer {
  mappingId: string
  mappedAt: string
}

/**
 * Fetch all registered remote MCP servers
 */
export function useRemoteMcps() {
  return useQuery<{ servers: RemoteMcpServer[] }>({
    queryKey: ['remote-mcps'],
    queryFn: async () => {
      const res = await apiFetch('/api/remote-mcps')
      if (!res.ok) throw new Error('Failed to fetch remote MCPs')
      return res.json()
    },
  })
}

/**
 * Fetch remote MCPs assigned to a specific agent
 */
export function useAgentRemoteMcps(agentSlug: string) {
  return useQuery<{ mcps: AgentRemoteMcp[] }>({
    queryKey: ['agent-remote-mcps', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/remote-mcps`)
      if (!res.ok) throw new Error('Failed to fetch agent remote MCPs')
      return res.json()
    },
    enabled: !!agentSlug,
  })
}

/**
 * Register a new remote MCP server
 */
export function useAddRemoteMcp() {
  const queryClient = useQueryClient()

  return useMutation<
    { server: RemoteMcpServer },
    Error,
    { name: string; url: string; authType?: string; accessToken?: string }
  >({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (data) => {
      const res = await apiFetch('/api/remote-mcps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to add MCP server')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['remote-mcps'] })
    },
  })
}

/**
 * Rename a remote MCP server
 */
export function useRenameRemoteMcp() {
  const queryClient = useQueryClient()

  return useMutation<void, Error, { mcpId: string; name: string }>({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ mcpId, name }) => {
      const res = await apiFetch(`/api/remote-mcps/${mcpId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const error = await res.json().catch(() => ({}))
        throw new Error(error.error || 'Failed to rename MCP server')
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['remote-mcps'] })
      // TODO: invalidate only affected agents once we can scope this by mcpId
      queryClient.invalidateQueries({ queryKey: ['agent-remote-mcps'] })
    },
  })
}

/**
 * Delete a remote MCP server
 */
export function useDeleteRemoteMcp() {
  const queryClient = useQueryClient()

  return useMutation<void, Error, string>({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (id) => {
      const res = await apiFetch(`/api/remote-mcps/${id}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to delete MCP server')
      }
    },
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['remote-mcps'] })
      queryClient.invalidateQueries({ queryKey: ['agent-remote-mcps'] })
      queryClient.removeQueries({ queryKey: ['mcp-agents', id] })
      queryClient.removeQueries({ queryKey: ['tool-policies', id] })
    },
  })
}

/**
 * Assign MCP server(s) to an agent
 */
export function useAssignMcpToAgent() {
  const queryClient = useQueryClient()

  return useMutation<void, Error, { agentSlug: string; mcpIds: string[] }>({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ agentSlug, mcpIds }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/remote-mcps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpIds }),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to assign MCP to agent')
      }
    },
    onSuccess: (_, { mcpIds }) => {
      // Bare prefix (not keyed on agentSlug): the agent-home Connections card keys
      // on the canonical id, but this mutation fires from the display-slug route, so
      // a targeted key would miss it. Matches the rename/delete mutations above.
      queryClient.invalidateQueries({ queryKey: ['agent-remote-mcps'] })
      for (const id of mcpIds) {
        queryClient.invalidateQueries({ queryKey: ['mcp-agents', id] })
      }
    },
  })
}

/**
 * Remove MCP server from an agent
 */
export function useRemoveMcpFromAgent() {
  const queryClient = useQueryClient()

  return useMutation<void, Error, { agentSlug: string; mcpId: string }>({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ agentSlug, mcpId }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/remote-mcps/${mcpId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to remove MCP from agent')
      }
    },
    onSuccess: (_, { mcpId }) => {
      // Bare prefix — see useAssignMcpToAgent: reaches the id-keyed home card too.
      queryClient.invalidateQueries({ queryKey: ['agent-remote-mcps'] })
      queryClient.invalidateQueries({ queryKey: ['mcp-agents', mcpId] })
    },
  })
}

/**
 * Hook to fetch agent slugs that have an MCP server mapped
 */
export function useMcpAgents(mcpId: string) {
  return useQuery<{ agentSlugs: string[] }>({
    queryKey: ['mcp-agents', mcpId],
    queryFn: async () => {
      const res = await apiFetch(`/api/remote-mcps/${mcpId}/agents`)
      if (!res.ok) throw new Error('Failed to fetch MCP agents')
      return res.json()
    },
    enabled: !!mcpId,
  })
}

/**
 * Trigger tool discovery for an MCP server
 */
export function useDiscoverMcpTools() {
  const queryClient = useQueryClient()

  return useMutation<
    { tools: Array<{ name: string; description?: string }> },
    Error,
    string
  >({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (mcpId) => {
      const res = await apiFetch(`/api/remote-mcps/${mcpId}/discover-tools`, {
        method: 'POST',
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to discover tools')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['remote-mcps'] })
      queryClient.invalidateQueries({ queryKey: ['agent-remote-mcps'] })
    },
  })
}

/**
 * Test connection to an MCP server
 */
export function useTestMcpConnection() {
  const queryClient = useQueryClient()

  return useMutation<{ success: boolean; error?: string; needsAuth?: boolean }, Error, string>({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (mcpId) => {
      const res = await apiFetch(`/api/remote-mcps/${mcpId}/test-connection`, {
        method: 'POST',
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Connection test failed')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['remote-mcps'] })
      queryClient.invalidateQueries({ queryKey: ['agent-remote-mcps'] })
    },
  })
}

/**
 * Invalidate remote MCPs query cache
 */
export function useInvalidateRemoteMcps() {
  const queryClient = useQueryClient()
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['remote-mcps'] }),
    [queryClient],
  )
}

/**
 * Initiate OAuth flow for an MCP server
 */
export function useInitiateMcpOAuth() {
  return useMutation<{ redirectUrl: string; state: string }, Error, { mcpId?: string; name?: string; url?: string; electron?: boolean; clientName?: string; clientId?: string; clientSecret?: string }>({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (data) => {
      const res = await apiFetch('/api/remote-mcps/initiate-oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to initiate OAuth')
      }
      return res.json()
    },
  })
}
