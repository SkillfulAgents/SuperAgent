import { z } from 'zod'
import { notificationCountsSchema, type NotificationTypeName } from './notification-filters'

export const notificationPreviewSourceSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
})

export const agentNotificationReadStateSchema = z.object({
  slug: z.string(),
  hasUnreadNotifications: z.boolean(),
  hasUnreadMention: z.boolean(),
  notificationPreview: z.string().optional(),
  notificationPreviewSource: notificationPreviewSourceSchema.optional(),
  markedUnreadSessionIds: z.array(z.string()),
  unreadSessionIds: z.array(z.string()),
  mentionedSessionIds: z.array(z.string()),
})

export const notificationReadStateSchema = notificationCountsSchema.extend({
  mentions: z.number().int().nonnegative(),
  agents: z.array(agentNotificationReadStateSchema),
})

export const notificationReadResponseSchema = z.object({
  success: z.literal(true),
  count: z.number().optional(),
  // Optional for a desktop client connected to an older server.
  readState: notificationReadStateSchema.optional(),
})

export type NotificationReadState = z.infer<typeof notificationReadStateSchema>
/** `all` with `types` is read-all on a filtered tab: only those types are read. */
export type NotificationReadTarget = { kind: 'all'; types?: readonly NotificationTypeName[] } | { kind: 'notification'; id: string } | { kind: 'session'; sessionId: string }
