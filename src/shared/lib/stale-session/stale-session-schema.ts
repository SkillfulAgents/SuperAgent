import { z } from 'zod'

/** Body for POST /api/agents/:id/sessions/branch */
export const branchSessionRequestSchema = z.object({
  // Constrained to a safe charset (no '/' or '.') so it cannot traverse out of the
  // agent's sessions directory when used to build the jsonl file path. Real session
  // ids look like "session_1781579330534_4vyak4s"; uuids also match this charset.
  fromSessionId: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/, 'invalid session id'),
  message: z.string().min(1),         // the user's original typed message
  model: z.string().optional(),       // inherited from source session if omitted
  effort: z.string().optional(),
})
export type BranchSessionRequest = z.infer<typeof branchSessionRequestSchema>

/** Structured output we require from the summarizer model. */
export const summaryPayloadSchema = z.object({
  summary: z.string().min(1),
})
export type SummaryPayload = z.infer<typeof summaryPayloadSchema>

/** Body for POST /api/agents/:id/sessions/summarize */
export const summarizeRequestSchema = z.object({
  fromSessionId: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/, 'invalid session id'),
})
export type SummarizeRequest = z.infer<typeof summarizeRequestSchema>

/** Response from POST /api/agents/:id/sessions/summarize. Rejects an empty summary. */
export const summarizeResponseSchema = z.object({
  summary: z.string().min(1),
})
export type SummarizeResponse = z.infer<typeof summarizeResponseSchema>

/** Body for POST /api/agents/:id/sessions. seedSummary + fromSessionId are an
 *  all-or-nothing pair (the carried-summary path); absent for a plain new chat.
 *  `message` is trimmed so a whitespace-only body is rejected, matching the old guard. */
export const createSessionRequestSchema = z.object({
  message: z.string().trim().min(1),
  model: z.string().optional(),
  effort: z.string().optional(),
  seedSummary: z.string().min(1).optional(),
  fromSessionId: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/, 'invalid session id').optional(),
}).superRefine((val, ctx) => {
  if ((val.seedSummary === undefined) !== (val.fromSessionId === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'seedSummary and fromSessionId must be provided together' })
  }
})
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>
