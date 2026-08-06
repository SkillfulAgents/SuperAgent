import { z } from 'zod'

/**
 * Wire shape of the client's subscribe call: `PushSubscription.toJSON()` plus
 * device metadata. Validated at the API boundary before anything is stored.
 */
export const pushSubscribeRequestSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2048),
    keys: z.object({
      p256dh: z.string().min(1).max(512),
      auth: z.string().min(1).max(512),
    }),
  }),
  /** Origin the PWA is served from — click-through URLs are built on this. */
  origin: z.string().url().max(512),
  deviceName: z.string().max(128).optional(),
})

export type PushSubscribeRequest = z.infer<typeof pushSubscribeRequestSchema>

export const pushUnsubscribeRequestSchema = z.object({
  endpoint: z.string().url().max(2048),
})
