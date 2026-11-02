import { readNotifications } from '@renderer/lib/notification-read-cache'
import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiNotification } from '@shared/lib/types/api'

// Re-export for convenience
export type { ApiNotification }

export interface PaginatedNotifications {
  items: ApiNotification[]
  total: number
}

/**
 * Fetch a page of notifications (server-side pagination).
 */
export function useNotifications(limit: number, offset: number = 0) {
  return useQuery<PaginatedNotifications>({
    queryKey: ['notifications', limit, offset],
    queryFn: async () => {
      const res = await apiFetch(`/api/notifications?limit=${limit}&offset=${offset}`)
      if (!res.ok) throw new Error('Failed to fetch notifications')
      return res.json()
    },
    refetchInterval: 30000,
  })
}

/**
 * Fetch unread notification count (for badge)
 */
export function useUnreadNotificationCount() {
  // `mentions`: the unread ones that tag you, drawn as an @ (auth mode).
  return useQuery<{ count: number; mentions?: number }>({
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
    meta: { skipGlobalErrorToast: true },
    mutationFn: (id: string) => readNotifications(queryClient, { kind: 'notification', id }),
  })
}

/** Mark all notifications read without a follow-up list request. */
export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient()
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: () => readNotifications(queryClient, { kind: 'all' }),
  })
}

/** Mark a session's notifications read; personal unread reminders are separate. */
export function useMarkSessionNotificationsRead() {
  const queryClient = useQueryClient()
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: (sessionId: string) => readNotifications(queryClient, { kind: 'session', sessionId }),
  })
}
