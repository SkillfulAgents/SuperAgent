import { z } from 'zod'

// Zod-at-the-boundary for the container -> host web fetch RPC. The in-container tool is untrusted
// input, so the host validates the body before dispatching to the active vendor. `url` must be a
// well-formed URL (the allowed-sites host check + vendor call depend on it parsing).
export const WebFetchRequestSchema = z.object({
  url: z.string().url().max(2000),
  maxChars: z.number().int().positive().optional(),
})

export type WebFetchRequest = z.infer<typeof WebFetchRequestSchema>
