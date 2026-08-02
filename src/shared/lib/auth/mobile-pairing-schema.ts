import { z } from 'zod'

// Plaintext pairing tokens are `mp_` + 32 random bytes base64url (43 chars),
// so a legitimate token is always well under this bound.
export const PAIRING_TOKEN_PREFIX = 'mp_'
export const MAX_PAIRING_TOKEN_LENGTH = 128

// A pairing token exists only to bridge the seconds between rendering a QR
// code and the phone scanning it.
export const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000

// A user can hold at most this many un-redeemed pairing tokens; minting past
// the cap deletes the oldest first.
export const MAX_OUTSTANDING_PAIRING_TOKENS = 3

// On `purpose: 'renew'` the superseded session is not killed outright — the
// device may still be mid-flight on it — but its expiry is clamped to at most
// this far out (never extended).
export const SUPERSEDE_GRACE_MS = 7 * 24 * 60 * 60 * 1000

// Device names are user-visible labels, not identity: trimmed and capped.
export const MAX_DEVICE_NAME_LENGTH = 64

const deviceNameSchema = z.string().max(256)

export const RedeemPairingRequestSchema = z.object({
  token: z.string().min(1).max(MAX_PAIRING_TOKEN_LENGTH),
  deviceName: deviceNameSchema.optional(),
  platform: z.string().max(64).optional(),
})

export type RedeemPairingRequest = z.infer<typeof RedeemPairingRequestSchema>

export const RENEW_PURPOSES = ['renew', 'additional-device'] as const
export type RenewPurpose = (typeof RENEW_PURPOSES)[number]

export const RenewMobileSessionRequestSchema = z.object({
  deviceName: deviceNameSchema.optional(),
  purpose: z.enum(RENEW_PURPOSES).optional(),
})

export type RenewMobileSessionRequest = z.infer<typeof RenewMobileSessionRequestSchema>

// Wire shape shared by /redeem and /renew: the session bearer token, its
// expiry, and just enough user identity for the app to label the account.
export const MobileSessionResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
  user: z.object({
    id: z.string().min(1),
    email: z.string().min(1),
    name: z.string(),
  }),
})

export type MobileSessionResponse = z.infer<typeof MobileSessionResponseSchema>
