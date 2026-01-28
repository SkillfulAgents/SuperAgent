import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiNotification } from '@shared/lib/types/api'

// Re-export for convenience
export type { ApiNotification }

/**
 * Fetch recent notifications
 */
export function useNotifications(limit: number = 50) {
  return useQuery<ApiNotification[]>({
    queryKey: ['notifications', limit],
    queryFn: async () => {
      const res = await apiFetch(`/api/notifications?limit=${limit}`)
      if (!res.ok) throw new Error('Failed to fetch notifications')
      return res.json()
    },
    refetchInterval: 30000, // Poll every 30s as backup
  })
}

/**
 * Fetch unread notification count (for badge)
 */
export function useUnreadNotificationCount() {
  return useQuery<{ count: number }>({
    queryKey: ['notifications', 'unread-count'],
    queryFn: async () => {
      const res = await apiFetch('/api/notifications/unread-count')
      if (!res.ok) throw new Error('Failed to fetch unread count')
      return res.json()
    },
    refetchInterval: 10000, // Poll more frequently for badge
  })
}

/**
 * Mark a single notification as read
 */
export function useMarkNotificationRead() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (notificationId: string) => {
      const res = await apiFetch(`/api/notifications/${notificationId}/read`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error('Failed to mark notification as read')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}

/**
 * Mark all notifications as read
 */
export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/api/notifications/read-all', {
        method: 'POST',
      })
      if (!res.ok) throw new Error('Failed to mark all notifications as read')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}

/**
 * Mark all notifications for a session as read
 */
export function useMarkSessionNotificationsRead() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await apiFetch(`/api/notifications/read-by-session/${sessionId}`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error('Failed to mark session notifications as read')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}
