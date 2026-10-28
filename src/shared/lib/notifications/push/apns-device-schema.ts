import { z } from 'zod'

/**
 * Wire shape of the native app's device registration call
 * (POST /api/push/devices). Validated at the API boundary before anything is
 * stored. The token is the raw APNs device token in hex — Apple documents no
 * fixed length (currently 32 bytes / 64 hex chars, historically promised to
 * grow), so accept a bounded hex range rather than exactly 64.
 */
export const apnsDeviceRegisterRequestSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64,200}$/i, 'Token must be 64-200 hex characters'),
  /** Which APNs environment issued the token (Xcode/dev builds → sandbox). */
  environment: z.enum(['sandbox', 'production']).default('production'),
  platform: z.string().max(64).default('ios'),
  deviceName: z.string().max(120).optional(),
  /**
   * Opaque client-chosen workspace id, echoed back in every push payload as
   * `workspaceId` so the app can route the push to the right paired deployment.
   */
  workspaceTag: z.string().max(128).optional(),
})

export type ApnsDeviceRegisterRequest = z.infer<typeof apnsDeviceRegisterRequestSchema>
