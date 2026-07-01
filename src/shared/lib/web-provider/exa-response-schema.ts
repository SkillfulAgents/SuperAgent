import { z } from 'zod'

// Zod-at-the-boundary for Exa's POST /search response. We require only the fields the v1
// adapter maps (url + the snippet/title/date inputs) and let everything else pass through,
// so vendor drift on fields we don't read can't break parsing. `.parse()` is the runtime
// narrowing (Iddo's narrow-don't-cast) so the adapter maps without `as`-casts.

export const ExaSearchResultSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),        // present on every Exa result; value may be null
  publishedDate: z.string().optional(), // ISO 8601; omitted where Exa has no date
  highlights: z.array(z.string()).optional(), // returned when contents.highlights is requested
  text: z.string().optional(),         // returned when contents.text is requested
})

export const ExaSearchResponseSchema = z.object({
  results: z.array(ExaSearchResultSchema),
  requestId: z.string().optional(),
})

export type ExaSearchResponse = z.infer<typeof ExaSearchResponseSchema>
