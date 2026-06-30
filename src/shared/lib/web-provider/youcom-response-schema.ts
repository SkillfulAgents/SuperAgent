import { z } from 'zod'

// Zod-at-the-boundary for You.com's GET /v1/search response. Every WebResult field is
// schema-optional in You's OpenAPI (snippets / page_age are genuinely absent on many live items),
// so requiring them would throw on valid data. We read web[] only — news[] has an asymmetric shape
// (no snippets/authors/favicon) for marginal gain. `.parse()` narrows so the adapter maps without
// `as`-casts.

export const YouSearchWebResultSchema = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(), // single string, NOT an array
  snippets: z.array(z.string()).optional(), // query-relevant excerpts; often absent
  page_age: z.string().optional(), // date-time publication timestamp; frequently absent
})

export const YouSearchResponseSchema = z.object({
  results: z.object({
    web: z.array(YouSearchWebResultSchema).optional(),
  }),
})

export type YouSearchResponse = z.infer<typeof YouSearchResponseSchema>
