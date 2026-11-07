import { z } from 'zod'

// Lets the initiating cache use the POST's projection without refetching for
// its own SSE echo. Other windows still refresh, including the same user's.
export const NOTIFICATION_CLIENT_HEADER = 'X-Notification-Client'
export const notificationClientIdSchema = z.string().uuid()
export const notificationChangeSchema = z.object({
  type: z.literal('notifications_changed'),
  agentSlug: z.string().optional(),
  sourceClientId: notificationClientIdSchema.optional(),
})
