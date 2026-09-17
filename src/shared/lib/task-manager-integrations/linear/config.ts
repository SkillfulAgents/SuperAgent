import { z } from 'zod'

export const LINEAR_SCOPES = ['read', 'write', 'app:mentionable', 'app:assignable'] as const
export const linearIdentitySchema = z.object({
  workspaceId: z.string().min(1), workspaceName: z.string(),
  appUserId: z.string().min(1), appName: z.string(), avatarUrl: z.string().nullish(),
})
export const linearTokensSchema = z.object({
  accessToken: z.string().min(1), refreshToken: z.string().min(1),
  expiresAt: z.number().finite().positive(), scope: z.string(),
})
export const linearConfigSchema = z.object({
  redirectUri: z.string().url(),
  clientId: z.string().min(1).optional(), clientSecret: z.string().min(1).optional(),
  identity: linearIdentitySchema.optional(), tokens: linearTokensSchema.optional(),
  authorizationPending: z.boolean().default(false),
  authorizationError: z.string().optional(),
  authorizedAt: z.number().optional(),
  syncedThrough: z.string().datetime().optional(),
  authorizationVersion: z.string().optional(),
  oauth: z.object({ stateHash: z.string(), verifier: z.string(), expiresAt: z.number(), claimed: z.boolean().optional() }).optional(),
  runOnStatusChange: z.boolean().default(false),
})
export type LinearConfig = z.infer<typeof linearConfigSchema>
export type LinearIdentity = z.infer<typeof linearIdentitySchema>
export type LinearTokens = z.infer<typeof linearTokensSchema>

export const linearCredentialsSchema = z.object({
  clientId: z.string().trim().min(1).max(256),
  clientSecret: z.string().trim().min(1).max(1024),
}).strict()

/** Empty input retries with stored credentials; replacements must include both fields. */
export const linearAuthorizationInputSchema = linearCredentialsSchema.partial().refine(
  input => !!input.clientId === !!input.clientSecret,
  'Supply both the client ID and client secret',
)
