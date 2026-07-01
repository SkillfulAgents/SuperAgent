import { z } from 'zod'
import { ExaSearchResultSchema } from './exa-response-schema'

// Zod-at-the-boundary for Exa's POST /contents response. The result object is identical to /search
// (Exa returns the same shape from both endpoints), so we reuse ExaSearchResultSchema — one source
// of truth for the raw Exa result. The fetch map reads only url + title + text + publishedDate;
// everything else passes through, so vendor drift on fields we don't read can't break parsing.
export const ExaContentsResponseSchema = z.object({
  results: z.array(ExaSearchResultSchema),
  requestId: z.string().optional(),
})

export type ExaContentsResponse = z.infer<typeof ExaContentsResponseSchema>
