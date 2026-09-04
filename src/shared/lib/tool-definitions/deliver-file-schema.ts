import { z } from 'zod'

/**
 * The `Delivered: {...}` JSON line that agent-container/src/tools/deliver-file.ts
 * writes at the end of a successful result. The tool stats the file anyway, so
 * the facts the UI needs travel as data instead of being scraped back out of the
 * sentence the model reads.
 *
 * Reader-lenient, like the search-links schema: a line that doesn't conform is
 * dropped and the caller falls back, rather than throwing on a transcript we
 * cannot control.
 */
export const deliveredFileSchema = z.object({
  sizeBytes: z.number().int().nonnegative(),
})

export type DeliveredFile = z.infer<typeof deliveredFileSchema>
