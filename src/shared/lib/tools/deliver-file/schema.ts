import { z } from 'zod'

/** Persisted tool input is untrusted transcript data, not the live MCP type. */
export const deliverFileInputSchema = z.object({
  filePath: z.string().min(1),
  description: z.string().optional(),
})

export type ValidatedDeliverFileInput = z.infer<typeof deliverFileInputSchema>

/** Text-bearing MCP result blocks accepted by the shared result parser. */
export const deliverFileResultBlocksSchema = z.array(z.object({
  type: z.string(),
  text: z.string().optional(),
}).passthrough())

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
