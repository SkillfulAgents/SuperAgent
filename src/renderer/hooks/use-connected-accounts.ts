import { apiFetch } from '@renderer/lib/api'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
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
  return useMutation<InitiateConnectionResponse, Error, { providerSlug: string; electron?: boolean }>({
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
    onSuccess: () => {
      // Invalidate after OAuth callback completes
      // The callback component will handle the refresh
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
 * Invalidate connected accounts cache (call after OAuth callback)
 */
export function useInvalidateConnectedAccounts() {
  const queryClient = useQueryClient()

  return () => {
    queryClient.invalidateQueries({ queryKey: ['connected-accounts'] })
  }
}
