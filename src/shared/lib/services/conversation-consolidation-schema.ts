import { z } from 'zod'

/** The four memory types the agent's own memory system uses. */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

/**
 * One durable memory entry, written as a frontmatter'd file the agent can
 * discover via its MEMORY.md index. `name` is a short kebab-case slug that also
 * keys the file, so reusing a name updates (dedupes) rather than duplicates.
 */
export const ConsolidationMemorySchema = z.object({
  name: z.string(),
  description: z.string(),
  type: z.enum(MEMORY_TYPES),
  body: z.string(),
})
export type ConsolidationMemory = z.infer<typeof ConsolidationMemorySchema>

/**
 * The structured output of a conversation consolidation pass:
 * - `memories`: durable, typed entries to write into the agent's memory store
 *   (empty array when nothing is worth keeping long-term).
 * - `recap`: a short continuity summary that seeds the next conversation in the
 *   same chat (empty string when there is nothing worth carrying forward).
 */
export const ConsolidationResultSchema = z.object({
  memories: z.array(ConsolidationMemorySchema),
  recap: z.string(),
})
export type ConsolidationResult = z.infer<typeof ConsolidationResultSchema>
