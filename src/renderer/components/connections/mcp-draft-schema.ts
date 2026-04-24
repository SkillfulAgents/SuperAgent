import { z } from 'zod'

export const mcpAuthTypeSchema = z.enum(['none', 'oauth', 'bearer'])
export type McpAuthType = z.infer<typeof mcpAuthTypeSchema>

/**
 * The shape of the MCP add form, validated at submit time. URLs must parse as
 * `https:` — the draft is filled from common-servers (where every entry is
 * https) or from custom user input.
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
          return new URL(value).protocol === 'https:'
        } catch {
          return false
        }
      }, 'URL must be a valid https:// URL'),
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
