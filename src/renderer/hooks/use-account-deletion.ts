import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiFetch } from '@renderer/lib/api'
import {
  accountDeletionStatusSchema,
  type AccountDeletionStatus,
} from '@shared/lib/account-deletion/account-deletion-schema'

const QUERY_KEY = ['account-deletion'] as const

/** The deletion request of the connected Gamut account, if one was made from this install. */
export function useAccountDeletionStatus(enabled: boolean) {
  return useQuery<AccountDeletionStatus>({
    queryKey: QUERY_KEY,
    enabled,
    queryFn: async () => {
      const res = await apiFetch('/api/account-deletion')
      if (!res.ok) throw new Error('Failed to load the account deletion status')
      return accountDeletionStatusSchema.parse(await res.json())
    },
  })
}

/**
 * Sends the deletion request for `userId`, the account the person confirmed
 * for. A failure leaves the stored request in place, so trying again sends the
 * same request, not a second one.
 */
export function useRequestAccountDeletion() {
  const queryClient = useQueryClient()

  return useMutation<AccountDeletionStatus, Error, string>({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (userId: string) => {
      const res = await apiFetch('/api/account-deletion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "We couldn't send your request. Please try again.")
      }
      return accountDeletionStatusSchema.parse(await res.json())
    },
    onSuccess: (status) => {
      queryClient.setQueryData(QUERY_KEY, status)
    },
    onError: () => {
      // The request id was stored before the send; show it beside the retry.
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })
}
