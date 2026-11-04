import { z } from 'zod'
import { oauthCredentialSchema } from './oauth-schema'

/** A device sign-in as the provider described it. */
export const oauthDeviceSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number(),
  interval: z.number(),
})

/** What a flow needs to poll again, as data: any process may take the next poll. */
export const oauthFlowStateSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('grok-subscription'), tokenEndpoint: z.string(), userinfoEndpoint: z.string().optional() }),
  z.object({ provider: z.literal('codex-subscription') }),
  z.object({ provider: z.literal('kimi-subscription'), region: z.enum(['us', 'cn']) }),
  z.object({
    provider: z.literal('minimax-subscription'),
    region: z.enum(['global', 'cn']),
    login: z.object({ device: oauthDeviceSchema.omit({ verification_uri_complete: true }), userCode: z.string(), verifier: z.string() }),
  }),
])

/** A pending subscription sign-in, keyed by its id. */
export const oauthLoginSchema = z.object({
  flow: oauthFlowStateSchema,
  device: oauthDeviceSchema,
  actor: z.string().nullable(),
  owner: z.string().nullable(),
  connectionId: z.string().optional(),
  expiresAt: z.number(),
  nextPollAt: z.number(),
  /** Which request took the current poll: two requests can compute the same time. */
  pollClaim: z.string().optional(),
  credential: oauthCredentialSchema.optional(),
})

export type OAuthDevice = z.infer<typeof oauthDeviceSchema>
export type OAuthFlowState = z.infer<typeof oauthFlowStateSchema>
export type OAuthLogin = z.infer<typeof oauthLoginSchema>
