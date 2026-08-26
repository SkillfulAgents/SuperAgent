import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { UserSettingsData } from '@shared/lib/services/user-settings-service'

export type { UserSettingsData }

const USER_SETTINGS_QUERY_KEY = ['user-settings']

async function fetchUserSettings(): Promise<UserSettingsData> {
  const res = await apiFetch('/api/user-settings')
  if (!res.ok) throw new Error('Failed to fetch user settings')
  return res.json()
}

export function useUserSettings() {
  return useQuery<UserSettingsData>({
    queryKey: USER_SETTINGS_QUERY_KEY,
    queryFn: fetchUserSettings,
  })
}

/**
 * A settings write: either the fields to store, or a function of the latest
 * cached settings returning them. Use the function form whenever the payload
 * is derived from current settings (e.g. "add one assignment to the map") —
 * it resolves when the mutation actually RUNS, not when it was queued. The
 * scope below serializes runs, and each run writes the server's response into
 * the cache before releasing the scope, so the function form always sees the
 * writes queued ahead of it; a plain object built from `useUserSettings` data
 * captures whatever the cache held at call time and silently reverts any
 * write that was still in flight.
 */
export type UserSettingsPatch =
  | Partial<UserSettingsData>
  | ((current: UserSettingsData) => Partial<UserSettingsData>)

export function useUpdateUserSettings() {
  const queryClient = useQueryClient()

  return useMutation<UserSettingsData, Error, UserSettingsPatch>({
    // Settings writes are partial read/merge/write operations on one document.
    // Serialize every instance of this mutation so rapid layout/visibility
    // changes cannot complete out of order and restore an older snapshot.
    scope: { id: 'user-settings' },
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (patch) => {
      // A functional patch must never see an empty cache: before the first
      // GET settles (or after it failed) the cache is undefined, and an
      // updater fed nothing would rebuild whole fields from scratch — one
      // early filing would erase every stored one the moment it lands.
      // ensureQueryData returns the cache when present and fetches when not;
      // a failed fetch fails the MUTATION instead of clobbering the row.
      const data =
        typeof patch === 'function'
          ? patch(
              await queryClient.ensureQueryData({
                queryKey: USER_SETTINGS_QUERY_KEY,
                queryFn: fetchUserSettings,
              })
            )
          : patch
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
      queryClient.setQueryData(USER_SETTINGS_QUERY_KEY, data)
    },
  })
}
