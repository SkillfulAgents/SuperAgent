import { readNotifications } from '@renderer/lib/notification-read-cache'
import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiNotification } from '@shared/lib/types/api'
import {
  notificationTypeCountsSchema,
  type NotificationTypeCounts,
  type NotificationTypeName,
} from '@shared/lib/notifications/notification-filters'

// Re-export for convenience
export type { ApiNotification }

export interface PaginatedNotifications {
  items: ApiNotification[]
  total: number
}

/**
 * Fetch a page of notifications (server-side pagination). `types` narrows the
 * page to those notification types; `enabled: false` skips the fetch (a tab
 * that shows no agent notifications).
 */
export function useNotifications(
  limit: number,
  offset: number = 0,
  options: { types?: readonly NotificationTypeName[]; enabled?: boolean } = {},
) {
  const types = options.types?.join(',')
  return useQuery<PaginatedNotifications>({
    queryKey: ['notifications', limit, offset, types ?? 'all'],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
      if (types) params.set('types', types)
      const res = await apiFetch(`/api/notifications?${params}`)
      if (!res.ok) throw new Error('Failed to fetch notifications')
      return res.json()
    },
    enabled: options.enabled ?? true,
    refetchInterval: 30000,
  })
}

/** Total and unread rows per notification type, for the Notifications page's filter tabs. */
export function useNotificationTypeCounts() {
  return useQuery<NotificationTypeCounts>({
    queryKey: ['notifications', 'type-counts'],
    queryFn: async () => {
      const res = await apiFetch('/api/notifications/type-counts')
      if (!res.ok) throw new Error('Failed to fetch notification type counts')
      return notificationTypeCountsSchema.parse(await res.json())
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

/**
 * Mark all notifications read without a follow-up list request. Pass `types`
 * to read only a filtered tab's notifications.
 */
export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient()
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: (types?: readonly NotificationTypeName[]) => readNotifications(queryClient, types ? { kind: 'all', types } : { kind: 'all' }),
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
