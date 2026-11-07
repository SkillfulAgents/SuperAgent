import { z } from 'zod'
import { oauthCredentialSchema } from './oauth-schema'

/**
 * What polling a provider needs besides the device data: rebuilt into the
 * provider's poll call by whichever process polls. It holds no functions.
 */
export const oauthLoginProviderSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('grok-subscription'),
    // Re-checked against x.ai's trusted hosts when polled.
    tokenEndpoint: z.string().min(1).max(2048),
    userinfoEndpoint: z.string().min(1).max(2048).optional(),
  }),
  z.object({ provider: z.literal('codex-subscription') }),
  z.object({ provider: z.literal('kimi-subscription'), region: z.enum(['us', 'cn']) }),
  z.object({
    provider: z.literal('minimax-subscription'),
    region: z.enum(['global', 'cn']),
    // The PKCE verifier MiniMax's token request presents.
    verifier: z.string().min(1).max(512),
  }),
])
export type OAuthLoginProvider = z.infer<typeof oauthLoginProviderSchema>

export const oauthLoginDeviceSchema = z.object({
  device_code: z.string().min(1).max(8192),
  user_code: z.string().min(1).max(512),
  verification_uri: z.string().min(1).max(2048),
  verification_uri_complete: z.string().min(1).max(2048).optional(),
})

const statusSchema = z.discriminatedUnion('state', [
  /** Waiting for the user to approve the device code. */
  z.object({ state: z.literal('pending') }),
  /** The provider issued a credential; a save may now take it. */
  z.object({ state: z.literal('completed'), credential: oauthCredentialSchema }),
  /** A save took the credential and is writing it to its connection. */
  z.object({ state: z.literal('saving'), credential: oauthCredentialSchema }),
  /** The provider ended the sign-in (declined, expired, failed); polls report this message. */
  z.object({ state: z.literal('failed'), message: z.string().min(1).max(500) }),
])

/** One device sign-in, as every process serving the tenant sees it. */
export const oauthLoginSchema = z.object({
  provider: oauthLoginProviderSchema,
  device: oauthLoginDeviceSchema,
  /** Who started it: the only user who may poll, save or cancel it. Null outside auth mode. */
  initiatingUserId: z.string().min(1).nullable(),
  /** The connection's owner; null for a global connection, which only an admin may sign in. */
  ownerId: z.string().min(1).nullable(),
  /** The connection being reconnected, if any. */
  connectionId: z.string().min(1).optional(),
  /** Epoch ms: the provider's device expiry, fixed at the start. The record expires then too. */
  expiresAt: z.number().finite(),
  schedule: z.object({
    /** Seconds between provider polls; each `slow_down` adds five. */
    intervalSeconds: z.number().positive(),
    /** Epoch ms before which no poll asks the provider. */
    nextPollAt: z.number().finite(),
  }),
  status: statusSchema,
  /** A fresh id per write, so a writer whose answer was lost can tell whether its write landed. */
  writeId: z.uuid(),
})
export type OAuthLogin = z.infer<typeof oauthLoginSchema>
