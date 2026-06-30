import { z } from 'zod'

// Zod-at-the-boundary for the container -> host web search RPC. The in-container tool is
// untrusted input, so the host validates the body before dispatching to the active vendor.
// Shape mirrors WebSearchOptions plus the required query.
export const WebSearchRequestSchema = z.object({
  query: z.string().min(1).max(2000),
  numResults: z.number().int().positive().optional(),
  includeDomains: z.array(z.string().max(253)).max(100).optional(),
  excludeDomains: z.array(z.string().max(253)).max(100).optional(),
  startPublishedDate: z.string().max(64).optional(),
  endPublishedDate: z.string().max(64).optional(),
})

export type WebSearchRequest = z.infer<typeof WebSearchRequestSchema>
