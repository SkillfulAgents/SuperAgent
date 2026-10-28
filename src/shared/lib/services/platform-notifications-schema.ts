/**
 * Platform Notifications Schemas
 *
 * Zod schemas for the platform proxy's /v1/notifications wire shapes and for
 * the Supabase Realtime INSERT record. Parsed at every network boundary: the
 * list/read responses, the realtime-config response, and each realtime record
 * before it is used.
 */

import { z } from 'zod'

/** One notification row as returned by GET /v1/notifications. */
export const platformNotificationSchema = z.object({
  id: z.string().min(1),
  org_id: z.string().nullish(),
  title: z.string(),
  body: z.string(),
  action_url: z.string().nullish(),
  kind: z.string(),
  read_at: z.string().nullish(),
  expires_at: z.string().nullish(),
  created_at: z.string(),
})

export type PlatformNotification = z.infer<typeof platformNotificationSchema>

export const platformNotificationsListSchema = z.object({
  notifications: z.array(platformNotificationSchema),
  total: z.number().int().nonnegative(),
  unread_count: z.number().int().nonnegative(),
})

export type PlatformNotificationsList = z.infer<typeof platformNotificationsListSchema>

/**
 * Realtime credentials from POST /v1/notifications/realtime. Same shape as the
 * webhook-events config plus the table the client should subscribe to; null
 * when the proxy has no acting-user context yet (the manager no-ops and
 * retries on its refresh cadence).
 */
export const notificationsRealtimeConfigSchema = z.object({
  realtime: z
    .object({
      url: z.string().min(1),
      apikey: z.string().min(1),
      jwt: z.string().min(1),
      channel: z.string(),
      table: z.string().optional(),
    })
    .nullable(),
})

export const markReadResponseSchema = z.object({
  ok: z.boolean(),
  updated: z.number().int().nonnegative(),
})

/**
 * The Supabase Realtime INSERT record (the full new row — WALRUS broadcasts
 * it after the RLS SELECT policy passes). The OS notification fires straight
 * from this record with no re-fetch, so it must carry title/body.
 */
export const platformNotificationRealtimeRecordSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    body: z.string(),
    action_url: z.string().nullish(),
    kind: z.string().optional(),
    status: z.string().optional(),
    read_at: z.string().nullish(),
    created_at: z.string(),
  })
  .passthrough()

export type PlatformNotificationRealtimeRecord = z.infer<
  typeof platformNotificationRealtimeRecordSchema
>
