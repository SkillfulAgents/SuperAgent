import { z } from 'zod'
import { integrationTransportConfigShape } from '../../agent-integrations/transport'

export const LINEAR_SCOPES = ['read', 'write', 'app:mentionable', 'app:assignable'] as const
export const linearIdentitySchema = z.object({
  workspaceId: z.string().min(1), workspaceName: z.string(),
  appUserId: z.string().min(1), appName: z.string(), avatarUrl: z.string().nullish(),
})
export const linearTokensSchema = z.object({
  accessToken: z.string().min(1), refreshToken: z.string().min(1),
  expiresAt: z.number().finite().positive(), scope: z.string(),
})
export const linearMcpToolsSchema = z.array(z.object({ name: z.string(), description: z.string().optional(), inputSchema: z.record(z.string(), z.unknown()).optional() }))
export const MAX_LINEAR_PARTICIPATION = 1000
export const linearParticipationSchema = z.object({
  workspaceId: z.string(), appUserId: z.string(),
  threads: z.array(z.object({ issueId: z.string(), rootId: z.string().optional() })).max(MAX_LINEAR_PARTICIPATION),
})
export const linearConfigSchema = z.object({
  redirectUri: z.string().url(),
  clientId: z.string().min(1).optional(), clientSecret: z.string().min(1).optional(),
  identity: linearIdentitySchema.optional(), tokens: linearTokensSchema.optional(),
  authorizationPending: z.boolean().default(false),
  authorizationError: z.string().optional(),
  authorizedAt: z.number().optional(),
  authorizationVersion: z.string().optional(),
  oauth: z.object({ stateHash: z.string(), verifier: z.string(), expiresAt: z.number(), claimed: z.boolean().optional() }).optional(),
  mcp: z.object({ available: z.boolean(), checkedAt: z.number(), tools: linearMcpToolsSchema.optional() }).optional(),
  runOnStatusChange: z.boolean().default(false),
  participation: linearParticipationSchema.optional(),
  ...integrationTransportConfigShape,
  /** Signs the app's webhooks (relay transport); Linear shows it once the app exists. */
  webhookSecret: z.string().min(1).optional(),
  /** What deliveries said about that secret; cleared whenever it changes. */
  webhookSecretStatus: z.enum(['verified', 'rejected']).optional(),
})
export type LinearConfig = z.infer<typeof linearConfigSchema>
export type LinearIdentity = z.infer<typeof linearIdentitySchema>
export type LinearTokens = z.infer<typeof linearTokensSchema>

export const linearCredentialsSchema = z.object({
  clientId: z.string().trim().min(1).max(256),
  clientSecret: z.string().trim().min(1).max(1024),
}).strict()

export const linearWebhookSecretSchema = z.string().trim().min(1).max(1024)

/**
 * Empty input retries with stored credentials; replacements must include both
 * fields. The webhook signing secret, for the relay transport, can come with
 * either.
 */
export const linearAuthorizationInputSchema = linearCredentialsSchema.partial()
  .extend({ webhookSecret: linearWebhookSecretSchema.optional() })
  .strict()
  .refine(input => !!input.clientId === !!input.clientSecret, 'Supply both the client ID and client secret')

export const linearSetupInputSchema = z.object({ transport: z.enum(['direct', 'relay']).optional() }).strict()

export const linearSettingsPatchSchema = z.object({
  config: z.never().optional(), showToolCalls: z.never().optional(), sessionTimeout: z.never().optional(),
  runOnStatusChange: z.boolean().optional(),
  /** Moves the installation to another transport; the user reconfigures the Linear app to match. */
  transport: z.enum(['direct', 'relay']).optional(),
  webhookSecret: linearWebhookSecretSchema.optional(),
}).passthrough()
