import { z } from 'zod'

export const mcpAuthTypeSchema = z.enum(['none', 'oauth', 'bearer'])
export type McpAuthType = z.infer<typeof mcpAuthTypeSchema>

/**
 * The shape of the MCP add form, validated at submit time. URLs must be https,
 * with a carve-out for http://localhost / http://127.0.0.1 — devs commonly run
 * local MCPs on a loopback http port during development.
 */
export const mcpDraftSchema = z
  .object({
    sourceSlug: z.string().min(1),
    name: z.string().trim().min(1, 'Name is required'),
    url: z
      .string()
      .trim()
      .min(1, 'URL is required')
      .refine((value) => {
        try {
          const u = new URL(value)
          if (u.protocol === 'https:') return true
          return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
        } catch {
          return false
        }
      }, 'URL must be https:// (http:// is allowed only for localhost)'),
    authType: mcpAuthTypeSchema,
    token: z.string().default(''),
  })
  .superRefine((draft, ctx) => {
    if (draft.authType === 'bearer' && draft.token.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Bearer token is required',
        path: ['token'],
      })
    }
  })

export type McpDraft = z.infer<typeof mcpDraftSchema>
