import { z } from 'zod'

// Zod-at-the-boundary for the container -> host web search RPC. The in-container tool is
// untrusted input, so the host validates the body before dispatching to the active vendor.
// Shape mirrors WebSearchOptions plus the required query.
export const WebSearchRequestSchema = z.object({
  query: z.string().min(1),
  numResults: z.number().int().positive().optional(),
  includeDomains: z.array(z.string()).optional(),
  excludeDomains: z.array(z.string()).optional(),
  startPublishedDate: z.string().optional(),
  endPublishedDate: z.string().optional(),
})

export type WebSearchRequest = z.infer<typeof WebSearchRequestSchema>
