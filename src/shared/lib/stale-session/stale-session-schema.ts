import { z } from 'zod'

/** Body for POST /api/agents/:id/sessions/summarize */
export const summarizeRequestSchema = z.object({
  fromSessionId: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/, 'invalid session id'),
})
export type SummarizeRequest = z.infer<typeof summarizeRequestSchema>

/** Response from POST /api/agents/:id/sessions/summarize. Rejects an empty summary. */
export const summarizeResponseSchema = z.object({
  summary: z.string().trim().min(1),
})
export type SummarizeResponse = z.infer<typeof summarizeResponseSchema>

/** Body for POST /api/agents/:id/sessions. seedSummary + fromSessionId are an
 *  all-or-nothing pair (the carried-summary path); absent for a plain new chat.
 *  `message` is trimmed so a whitespace-only body is rejected, matching the old guard. */
export const createSessionRequestSchema = z.object({
  message: z.string().trim().min(1),
  // model + effort are validated and applied separately via parseRuntimeOptions on
  // the raw body, so they are intentionally not declared here — declaring them
  // would be a decorative duplicate the handler never reads.
  seedSummary: z.string().min(1).optional(),
  fromSessionId: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/, 'invalid session id').optional(),
}).superRefine((val, ctx) => {
  if ((val.seedSummary === undefined) !== (val.fromSessionId === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'seedSummary and fromSessionId must be provided together' })
  }
})
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>
