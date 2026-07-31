import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { UserSettingsData } from '@shared/lib/services/user-settings-service'

export type { UserSettingsData }

export function useUserSettings() {
  return useQuery<UserSettingsData>({
    queryKey: ['user-settings'],
    queryFn: async () => {
      const res = await apiFetch('/api/user-settings')
      if (!res.ok) throw new Error('Failed to fetch user settings')
      return res.json()
    },
  })
}

export function useUpdateUserSettings() {
  const queryClient = useQueryClient()

  return useMutation<UserSettingsData, Error, Partial<UserSettingsData>>({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (data) => {
      const res = await apiFetch('/api/user-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to update user settings')
      }
      return res.json()
    },
    onSuccess: (data) => {
      // The PUT returns the full merged settings — write them straight into
      // the cache. (invalidate + refetch left a window where consumers that
      // clear optimistic state on settle briefly rendered the stale cache,
      // e.g. a resized home card flickering back to its old size.)
      queryClient.setQueryData(['user-settings'], data)
    },
  })
}
