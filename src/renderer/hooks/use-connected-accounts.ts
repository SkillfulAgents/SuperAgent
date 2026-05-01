import { apiFetch } from '@renderer/lib/api'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import type { Provider } from '@shared/lib/composio/providers'

export interface ConnectedAccount {
  id: string
  composioConnectionId: string
  toolkitSlug: string
  displayName: string
  status: 'active' | 'revoked' | 'expired'
  createdAt: string
  updatedAt: string
  provider?: Provider
}

export interface AgentConnectedAccount extends ConnectedAccount {
  mappingId: string
  mappedAt: string
}

interface ConnectedAccountsResponse {
  accounts: ConnectedAccount[]
}

interface InitiateConnectionResponse {
  connectionId: string
  redirectUrl: string
  providerSlug: string
}

/**
 * Hook to fetch all connected accounts
 */
export function useConnectedAccounts() {
  return useQuery<ConnectedAccountsResponse>({
    queryKey: ['connected-accounts'],
    queryFn: async () => {
      const res = await apiFetch('/api/connected-accounts')
      if (!res.ok) throw new Error('Failed to fetch connected accounts')
      return res.json()
    },
  })
}

/**
 * Hook to fetch connected accounts assigned to a specific agent
 */
export function useAgentConnectedAccounts(agentSlug: string) {
  return useQuery<{ accounts: AgentConnectedAccount[] }>({
    queryKey: ['agent-connected-accounts', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/connected-accounts`)
      if (!res.ok) throw new Error('Failed to fetch agent connected accounts')
      return res.json()
    },
    enabled: !!agentSlug,
  })
}

/**
 * Hook to fetch connected accounts for a specific toolkit
 */
export function useConnectedAccountsByToolkit(toolkit: string) {
  const { data, ...rest } = useConnectedAccounts()

  return {
    ...rest,
    data: data ? {
      accounts: data.accounts.filter(a => a.toolkitSlug === toolkit)
    } : undefined
  }
}

/**
 * Hook to initiate a new OAuth connection
 */
export function useInitiateConnection() {
  const { track } = useAnalyticsTracking()

  return useMutation<InitiateConnectionResponse, Error, { providerSlug: string; electron?: boolean; location?: string }>({
    mutationFn: async ({ providerSlug, electron }) => {
      const res = await apiFetch('/api/connected-accounts/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerSlug, electron }),
      })

      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to initiate connection')
      }

      return res.json()
    },
    onSuccess: (_, variables) => {
      track('account_added', { slug: variables.providerSlug, location: variables.location ?? 'settings' })
    },
  })
}

/**
 * Hook to delete a connected account
 */
export function useDeleteConnectedAccount() {
  const queryClient = useQueryClient()

  return useMutation<void, Error, string>({
    mutationFn: async (accountId) => {
      const res = await apiFetch(`/api/connected-accounts/${accountId}`, {
        method: 'DELETE',
      })

      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to delete account')
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connected-accounts'] })
    },
  })
}

/**
 * Hook to rename a connected account
 */
export function useRenameConnectedAccount() {
  const queryClient = useQueryClient()

  return useMutation<ConnectedAccount, Error, { accountId: string; displayName: string }>({
    mutationFn: async ({ accountId, displayName }) => {
      const res = await apiFetch(`/api/connected-accounts/${accountId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName }),
      })

      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to rename account')
      }

      const data = await res.json()
      return data.account
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connected-accounts'] })
      queryClient.invalidateQueries({ queryKey: ['agent-connected-accounts'] })
    },
  })
}

/**
 * Hook to assign connected account(s) to an agent
 */
export function useAssignAccountsToAgent() {
  const queryClient = useQueryClient()

  return useMutation<void, Error, { agentSlug: string; accountIds: string[] }>({
    mutationFn: async ({ agentSlug, accountIds }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/connected-accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountIds }),
      })
      if (!res.ok) {
        const error = await res.json().catch(() => ({}))
        throw new Error(error.error || 'Failed to assign accounts to agent')
      }
    },
    onSuccess: (_, { agentSlug }) => {
      queryClient.invalidateQueries({ queryKey: ['agent-connected-accounts', agentSlug] })
      queryClient.invalidateQueries({ queryKey: ['connected-accounts'] })
    },
  })
}

/**
 * Hook to remove a connected account from an agent
 */
export function useRemoveAgentConnectedAccount() {
  const queryClient = useQueryClient()

  return useMutation<void, Error, { agentSlug: string; accountId: string }>({
    mutationFn: async ({ agentSlug, accountId }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/connected-accounts/${accountId}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('Failed to remove account from agent')
    },
    onSuccess: (_, { agentSlug }) => {
      queryClient.invalidateQueries({ queryKey: ['agent-connected-accounts', agentSlug] })
      queryClient.invalidateQueries({ queryKey: ['connected-accounts'] })
    },
  })
}

/**
 * Hook to fetch active webhook trigger counts per connected account
 */
export function useTriggerCountsPerAccount() {
  return useQuery<Record<string, number>>({
    queryKey: ['trigger-counts-per-account'],
    queryFn: async () => {
      const res = await apiFetch('/api/connected-accounts/trigger-counts')
      if (!res.ok) return {}
      return res.json()
    },
  })
}

/**
 * Invalidate connected accounts cache (call after OAuth callback)
 */
export function useInvalidateConnectedAccounts() {
  const queryClient = useQueryClient()

  return () => {
    queryClient.invalidateQueries({ queryKey: ['connected-accounts'] })
  }
}
