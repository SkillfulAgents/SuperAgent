import { z } from 'zod'

/** What libWebAuthBridge's `web_auth_start` returns, as JSON. */
export const webAuthResultSchema = z.union([
  z.object({ url: z.string().min(1) }),
  z.object({ cancelled: z.literal(true) }),
  z.object({ error: z.string() }),
])

export type WebAuthResult = z.infer<typeof webAuthResultSchema>
