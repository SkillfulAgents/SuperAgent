import { z } from 'zod'

// Zod-at-the-boundary for Parallel's POST /v1/search response. We require only the fields the
// adapter maps (url + the snippet/title/date inputs) and let everything else pass through, so
// vendor drift on fields we don't read can't break parsing. `.parse()` is the runtime narrowing
// (narrow-don't-cast) so the adapter maps without `as`-casts.
//
// `search_id` / `session_id` are documented as required on the response, but we never map them,
// so per the require-only-mapped-fields rule they stay optional — we don't validate vendor
// internals we discard.

export const ParallelSearchResultSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),                 // present on every result; value may be null
  publish_date: z.string().nullable().optional(), // YYYY-MM-DD; may be null or absent
  excerpts: z.array(z.string()).optional(),     // markdown excerpts (our snippet source); on by default
})

export const ParallelSearchResponseSchema = z.object({
  results: z.array(ParallelSearchResultSchema),
  search_id: z.string().optional(),
  session_id: z.string().optional(),
})

export type ParallelSearchResponse = z.infer<typeof ParallelSearchResponseSchema>
