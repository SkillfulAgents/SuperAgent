import { z } from 'zod'

/**
 * The Notifications page's type filters, grouped by what the person has to do
 * about a notification rather than by its stored type: `session_waiting` alone
 * covers questions, approvals, sign-ins, secrets and reviews.
 *
 * Renderer-safe leaf (no DB import), so the server's `?types=` filter, the
 * page's tabs and their counts read one map and can never drift.
 */

export const NOTIFICATION_TYPES = [
  'session_complete',
  'session_waiting',
  'session_scheduled',
  'session_webhook',
  'session_chat_integration',
  'session_mention',
] as const
export type NotificationTypeName = (typeof NOTIFICATION_TYPES)[number]

export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES)

/** Filters over the local `notifications` table, in tab order. */
export const AGENT_NOTIFICATION_FILTERS = {
  mentions: ['session_mention'],
  'needs-you': ['session_waiting'],
  completed: ['session_complete'],
  automations: ['session_scheduled', 'session_webhook', 'session_chat_integration'],
} as const satisfies Record<string, readonly NotificationTypeName[]>

export type AgentNotificationFilter = keyof typeof AGENT_NOTIFICATION_FILTERS

/**
 * Every tab: `all`, the agent filters, and `announcements` (platform
 * notifications, which come from the platform proxy and never reach the local table).
 */
export const NOTIFICATION_FILTERS = ['all', 'mentions', 'needs-you', 'completed', 'automations', 'announcements'] as const
export type NotificationFilter = (typeof NOTIFICATION_FILTERS)[number]

export const notificationFilterSchema = z.enum(NOTIFICATION_FILTERS)

export function isAgentNotificationFilter(filter: NotificationFilter): filter is AgentNotificationFilter {
  return Object.hasOwn(AGENT_NOTIFICATION_FILTERS, filter)
}

/** The stored types a filter shows; undefined for `all` (no narrowing) and `announcements` (none). */
export function notificationFilterTypes(filter: NotificationFilter): readonly NotificationTypeName[] | undefined {
  return isAgentNotificationFilter(filter) ? AGENT_NOTIFICATION_FILTERS[filter] : undefined
}

/**
 * Parse a `types` query value (comma-separated) at the API boundary.
 * Absent or empty means no filter. An unknown type fails the parse, so a typo
 * can't quietly turn into "show everything".
 */
export const notificationTypesQuerySchema = z
  .string()
  .optional()
  .transform((raw) => (raw ? raw.split(',').map((t) => t.trim()).filter(Boolean) : []))
  .pipe(z.array(notificationTypeSchema))
  .transform((types) => (types.length > 0 ? types : undefined))

/** Body of `POST /api/notifications/read-all`: optional types narrow the write. */
export const readAllNotificationsBodySchema = z.object({
  types: z.array(notificationTypeSchema).min(1).optional(),
})

const typeCountSchema = z.object({
  total: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
})

/** Per-type totals (every type present, zero-filled) for tab counts and hiding empty tabs. */
export const notificationTypeCountsSchema = z.object({
  types: z.record(notificationTypeSchema, typeCountSchema),
})
export type NotificationTypeCounts = z.infer<typeof notificationTypeCountsSchema>
