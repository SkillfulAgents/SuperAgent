import { z } from 'zod'
import { githubSlugSchema } from './config-schema'

export const githubAccountSchema = z.object({ login: z.string().regex(/^[a-zA-Z0-9-]+(?:\[bot\])?$/).max(105), id: z.number().int(), type: z.string().optional() })
export const githubAppSchema = z.object({ id: z.number().int(), slug: githubSlugSchema, name: z.string(), owner: githubAccountSchema })
export const githubManifestResultSchema = githubAppSchema.extend({ pem: z.string().min(1), webhook_secret: z.string().min(1) })
export const githubInstallationSchema = z.object({ id: z.number().int(), app_id: z.number().int(), account: githubAccountSchema, suspended_at: z.string().nullable(), permissions: z.record(z.string(), z.string()) })
export const githubTokenSchema = z.object({ token: z.string().min(1), expires_at: z.iso.datetime() })
export const githubIssueSchema = z.object({
  id: z.number().int(), number: z.number().int().positive(), title: z.string(), body: z.string().nullable(),
  html_url: z.url(), updated_at: z.string(), state: z.string(), user: githubAccountSchema,
  pull_request: z.object({}).loose().optional(),
})
export const githubCommentSchema = z.object({
  id: z.number().int(), body: z.string(), html_url: z.url(), user: githubAccountSchema,
  created_at: z.string(), updated_at: z.string(), in_reply_to_id: z.number().int().optional(),
})
export const githubCommentsSchema = z.array(githubCommentSchema)
export const githubReviewSchema = z.object({ id: z.number().int(), body: z.string().nullable(), user: githubAccountSchema, submitted_at: z.string().nullable(), html_url: z.url(), state: z.string() })
export const githubPermissionSchema = z.object({ permission: z.string() })
export const githubWebhookSchema = z.object({
  action: z.string().optional(), installation: z.object({ id: z.number().int() }).optional(),
  repository: z.object({ name: z.string().regex(/^[a-zA-Z0-9_.-]+$/), owner: githubAccountSchema }).optional(),
  sender: githubAccountSchema.optional(), issue: githubIssueSchema.optional(), pull_request: githubIssueSchema.optional(),
  comment: githubCommentSchema.optional(), review: githubReviewSchema.optional(),
})
export type GitHubWebhook = z.infer<typeof githubWebhookSchema>
export const githubInstallCallbackSchema = z.object({ installation_id: z.coerce.number().int().positive(), setup_action: z.enum(['install', 'update']).optional() })

export const githubCreatedSchema = z.object({ id: z.number().int() })
