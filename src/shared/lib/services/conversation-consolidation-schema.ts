import { z } from 'zod'

/**
 * The structured output of a conversation consolidation pass.
 *
 * - `durableMemory`: lasting, cross-conversation facts/lessons to write into the
 *   agent's persistent memory. Empty string when nothing is worth keeping.
 * - `recap`: a short continuity summary that seeds the next conversation in the
 *   same chat. Empty string when there is nothing worth carrying forward.
 */
export const ConsolidationResultSchema = z.object({
  durableMemory: z.string(),
  recap: z.string(),
})

export type ConsolidationResult = z.infer<typeof ConsolidationResultSchema>
