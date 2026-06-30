import { z } from 'zod'

// Zod-at-the-boundary for Firecrawl's POST /v2/search response. We require only the fields the
// adapter maps (url + description/title) and let everything else pass through. `data.web` is
// optional (a non-web `sources` request omits it). `title` is a plain string in the OpenAPI but the
// live API can return null, so we accept null defensively. `.parse()` narrows so the adapter maps
// without `as`-casts.

export const FirecrawlSearchWebResultSchema = z.object({
  url: z.string(),
  title: z.string().nullable().optional(),
  description: z.string().optional(), // our snippet source
  // (per-result `metadata` and scrape-only fields are unknown keys here — stripped, not mapped)
})

export const FirecrawlSearchResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z.object({
    web: z.array(FirecrawlSearchWebResultSchema).optional(),
  }),
  id: z.string().optional(),
  creditsUsed: z.number().optional(),
})

export type FirecrawlSearchResponse = z.infer<typeof FirecrawlSearchResponseSchema>
