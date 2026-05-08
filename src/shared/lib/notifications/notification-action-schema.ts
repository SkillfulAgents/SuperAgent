import { z } from 'zod'

/**
 * Schemas for notification action payloads.
 *
 * Boundaries we validate at:
 *  - Renderer SSE handler reads `actionContext` off the broadcast payload.
 *    A malicious server-side broadcaster (or compromised SSE pipe) can lie
 *    about the shape, so we parse instead of casting `as unknown`.
 *  - Renderer IPC handler receives `notification-event` from main with the
 *    same `context` field round-tripped through Electron IPC.
 *
 * If a payload doesn't pass validation it's silently dropped at the
 * boundary — there's no actionable user-facing error for an
 * unparseable notification interaction.
 */

const ProxyReviewContextSchema = z.object({
  kind: z.literal('proxy_review'),
  reviewId: z.string().min(1),
  agentSlug: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  // Index-aligned with the `actions` array. Decoupling decision from index
  // lets us reorder the buttons in notification-manager without silently
  // flipping Approve/Deny in the renderer dispatcher (see review S6).
  decisions: z.array(z.enum(['allow', 'deny'])).min(1).max(4).optional(),
  // ID of the DB notification record so the renderer can mark it as read
  // when the user interacts with the OS notification (click or action).
  notificationId: z.string().min(1).optional(),
})

export const NotificationActionContextSchema = z.discriminatedUnion('kind', [
  ProxyReviewContextSchema,
])

export type NotificationActionContext = z.infer<typeof NotificationActionContextSchema>

/**
 * Best-effort read of common notification metadata from a context blob,
 * regardless of `kind`. Used by interaction handlers that just want to
 * mark a notification as read on click/action — they don't need to know
 * the action shape.
 */
export const NotificationMetadataSchema = z
  .object({
    notificationId: z.string().min(1).optional(),
    agentSlug: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
  })
  .passthrough()

export const NotificationEventSchema = z.object({
  type: z.enum(['click', 'action']),
  actionIndex: z.number().int().nonnegative().optional(),
  // context may be absent for legacy/non-action notifications. When present
  // it must parse; an invalid context drops the whole event at the renderer.
  context: z.unknown().optional(),
})

export type NotificationEvent = z.infer<typeof NotificationEventSchema>

/**
 * Cap on the number of action buttons we accept. macOS Notification supports
 * at most 2 visible actions in Banner mode; we cap at 4 as defense-in-depth
 * for any future broadcaster bug or attacker injection.
 */
export const MAX_NOTIFICATION_ACTIONS = 4
export const MAX_NOTIFICATION_ACTION_TEXT_LENGTH = 64

export const NotificationActionSchema = z.object({
  text: z.string().min(1).max(MAX_NOTIFICATION_ACTION_TEXT_LENGTH),
})
export const NotificationActionsArraySchema = z
  .array(NotificationActionSchema)
  .max(MAX_NOTIFICATION_ACTIONS)
