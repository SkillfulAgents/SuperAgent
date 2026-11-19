import { z } from 'zod'
import { integrationRelayConfigShape } from '../../agent-integrations/transport'

export const githubSlugSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/).max(100)
export const githubSetupInputSchema = z.object({ organization: githubSlugSchema.optional() }).strict()
export const githubAuthorizationInputSchema = z.object({}).strict()
export const githubToolsSchema = z.array(z.object({ name: z.string(), description: z.string().optional(), inputSchema: z.record(z.string(), z.unknown()).optional() }))
export const githubConfigSchema = z.object({
  redirectUri: z.url(),
  organization: githubSlugSchema.optional(),
  ...integrationRelayConfigShape,
  app: z.object({
    id: z.string().regex(/^\d+$/), slug: githubSlugSchema, name: z.string(), owner: githubSlugSchema,
    privateKey: z.string().min(1), webhookSecret: z.string().min(1),
  }).optional(),
  installation: z.object({ id: z.number().int().positive(), account: githubSlugSchema, botId: z.number().int().positive() }).optional(),
  authorizationVersion: z.string().optional(),
  authorizationError: z.string().optional(),
  pending: z.object({ stateHash: z.string(), expiresAt: z.number(), phase: z.enum(['manifest', 'installation']), claimed: z.boolean().default(false) }).optional(),
  mcp: z.object({ available: z.boolean(), checkedAt: z.number(), tools: githubToolsSchema.optional() }).optional(),
})
export type GitHubConfig = z.infer<typeof githubConfigSchema>

export function parseGitHubConfig(json: string): GitHubConfig {
  try { return githubConfigSchema.parse(JSON.parse(json)) }
  catch { throw new Error('Invalid stored GitHub integration configuration') }
}
