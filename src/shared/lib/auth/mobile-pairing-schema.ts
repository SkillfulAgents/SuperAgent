import { z } from 'zod'

// Plaintext pairing tokens are `mp_` + 32 random bytes base64url (43 chars),
// so a legitimate token is always well under this bound.
export const PAIRING_TOKEN_PREFIX = 'mp_'
export const MAX_PAIRING_TOKEN_LENGTH = 128

// Refresh credentials use the same entropy as pairing tokens but a distinct
// prefix so the two grants can never be confused at an endpoint boundary.
export const MOBILE_REFRESH_TOKEN_PREFIX = 'mr_'
export const MAX_MOBILE_REFRESH_TOKEN_LENGTH = 128

// A pairing token exists only to bridge the seconds between rendering a QR
// code and the phone scanning it.
export const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000

// A user can hold at most this many un-redeemed pairing tokens; minting past
// the cap deletes the oldest first.
export const MAX_OUTSTANDING_PAIRING_TOKENS = 3

// Device names are user-visible labels, not identity: trimmed and capped.
export const MAX_DEVICE_NAME_LENGTH = 64

const deviceNameSchema = z.string().max(256)

export const RedeemPairingRequestSchema = z
  .object({
    token: z.string().min(1).max(MAX_PAIRING_TOKEN_LENGTH),
    deviceName: deviceNameSchema.optional(),
    platform: z.string().max(64).optional(),
  })
  .strict()

export type RedeemPairingRequest = z.infer<typeof RedeemPairingRequestSchema>

export const RenewMobileSessionRequestSchema = z
  .object({
    refreshToken: z.string().min(1).max(MAX_MOBILE_REFRESH_TOKEN_LENGTH),
    deviceName: deviceNameSchema.optional(),
  })
  .strict()

export type RenewMobileSessionRequest = z.infer<typeof RenewMobileSessionRequestSchema>

// Wire shape shared by /redeem and /renew: a standard-lived Better Auth access
// session plus a separately rotated device refresh credential.
export const MobileSessionResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
  refreshToken: z.string().min(1),
  refreshExpiresAt: z.iso.datetime(),
  deviceId: z.string().min(1),
  user: z.object({
    id: z.string().min(1),
    email: z.string().min(1),
    name: z.string(),
  }),
})

export type MobileSessionResponse = z.infer<typeof MobileSessionResponseSchema>
