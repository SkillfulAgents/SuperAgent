import { z } from 'zod'

export const oauthCredentialSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().finite(),
  accountId: z.string().optional(),
  accountLabel: z.string().optional(),
  // Persist failure state so waiters across workers do not repeat failed exchanges.
  refreshFailure: z.object({ reconnectRequired: z.boolean(), retryAt: z.number().finite() }).optional(),
  // A database compare-and-set lease coordinates refresh across app workers.
  refreshLease: z.object({ id: z.string(), expiresAt: z.number() }).optional(),
})
export type OAuthCredential = z.infer<typeof oauthCredentialSchema>
