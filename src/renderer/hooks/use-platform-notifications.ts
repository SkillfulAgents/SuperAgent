import { apiFetch } from '@renderer/lib/api'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

/**
 * Platform notification as served by /api/platform-notifications (the
 * platform proxy's wire shape — snake_case, live read, no local mirror).
 */
export interface ApiPlatformNotification {
  id: string
  org_id?: string | null
  title: string
  body: string
  action_url?: string | null
  kind: string
  read_at?: string | null
  expires_at?: string | null
  created_at: string
}

export interface PlatformNotificationsList {
  notifications: ApiPlatformNotification[]
  total: number
  unread_count: number
  connected: boolean
}

/**
 * Fetch the newest `limit` platform notifications. Proxy-live: a short
 * staleTime softens the fetch; realtime INSERTs invalidate via the
 * `platform_notifications_changed` SSE signal.
 */
export function usePlatformNotifications(limit: number) {
  return useQuery<PlatformNotificationsList>({
    queryKey: ['platform-notifications', limit],
    queryFn: async () => {
      const res = await apiFetch(`/api/platform-notifications?limit=${limit}`)
      if (!res.ok) throw new Error('Failed to fetch platform notifications')
      return res.json()
    },
    staleTime: 15000,
    refetchInterval: 60000,
  })
}

/** Unread platform-notification count (combined into the sidebar badge). */
export function usePlatformUnreadCount() {
  return useQuery<{ count: number }>({
    queryKey: ['platform-notifications', 'unread-count'],
    queryFn: async () => {
      const res = await apiFetch('/api/platform-notifications/unread-count')
      if (!res.ok) throw new Error('Failed to fetch platform unread count')
      return res.json()
    },
    staleTime: 15000,
    refetchInterval: 30000,
  })
}

/** Mark platform notifications read (write-through to the platform). */
export function useMarkPlatformNotificationsRead() {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (ids: string[]) => {
      const res = await apiFetch('/api/platform-notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!res.ok) throw new Error('Failed to mark platform notifications read')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-notifications'] })
    },
  })
}

/** Mark every unread platform notification read. */
export function useMarkAllPlatformNotificationsRead() {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async () => {
      const res = await apiFetch('/api/platform-notifications/read-all', {
        method: 'POST',
      })
      if (!res.ok) throw new Error('Failed to mark all platform notifications read')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-notifications'] })
    },
  })
}
