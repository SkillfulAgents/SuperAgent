import { z } from 'zod'

/** What libWebAuthBridge's `web_auth_start` returns, as JSON. */
export const webAuthResultSchema = z.union([
  z.object({ url: z.string().min(1) }),
  z.object({ cancelled: z.literal(true) }),
  z.object({ error: z.string() }),
])

export type WebAuthResult = z.infer<typeof webAuthResultSchema>

/** What libWebAuthBridge's `apple_sign_in_start` returns, as JSON. */
export const appleSignInResultSchema = z.union([
  z.object({ idToken: z.string().min(1), nonce: z.string().min(1), name: z.string().optional() }),
  z.object({ cancelled: z.literal(true) }),
  z.object({ error: z.string() }),
])

export type AppleSignInResult = z.infer<typeof appleSignInResultSchema>
