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
