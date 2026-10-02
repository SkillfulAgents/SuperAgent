import { z } from 'zod'
import { callWebHost, textResult, XAgentError } from './host-client'
import { formatWebSearchResults, type WebSearchHostResult } from './format-results'

export const webSearchInputSchema = z.object({
  query: z.string().describe('The search query.'),
  numResults: z.number().int().positive().optional().describe('Maximum number of results to return.'),
  includeDomains: z.array(z.string()).optional().describe('Only return results from these domains.'),
  excludeDomains: z.array(z.string()).optional().describe('Exclude results from these domains.'),
  startPublishedDate: z.string().optional().describe('Only results published on or after this ISO 8601 date.'),
  endPublishedDate: z.string().optional().describe('Only results published on or before this ISO 8601 date.'),
})

type WebSearchArgs = z.infer<typeof webSearchInputSchema>

// Shared with the root integration test, which does not install the container SDK.
export async function handleWebSearch(args: WebSearchArgs) {
  try {
    const data = await callWebHost<WebSearchHostResult>('web-search', 'search', args)
    return textResult(formatWebSearchResults(data))
  } catch (error) {
    const msg = error instanceof XAgentError ? error.message : String(error)
    return textResult(`Web search failed: ${msg}`, true)
  }
}
