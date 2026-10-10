import { z } from 'zod'

/** The last backend outcome, retained for delivery; it never determines activity. */
export const sessionTurnOutcomeSchema = z.object({
  id: z.string(),
  status: z.enum(['completed', 'cancelled', 'failed']),
  responseText: z.string(),
  error: z.string().nullable(),
})

export type SessionTurnOutcome = z.infer<typeof sessionTurnOutcomeSchema>
