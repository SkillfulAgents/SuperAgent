import { z } from 'zod'

/** A recoverable level, not an edge that clients must happen to hear. */
export const sessionExecutionSchema = z.object({
  epoch: z.string(),
  revision: z.number().int().nonnegative(),
  turnId: z.string().nullable(),
  phase: z.enum(['idle', 'running', 'finishing', 'waiting_background', 'completed', 'cancelled', 'failed']),
  backgroundTaskCount: z.number().int().nonnegative(),
  responseText: z.string(),
  error: z.string().nullable(),
})

export type SessionExecution = z.infer<typeof sessionExecutionSchema>

export function executionEnded(execution: SessionExecution): boolean {
  return execution.phase === 'completed' || execution.phase === 'cancelled' || execution.phase === 'failed'
}
