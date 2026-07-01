import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callWebHost, textResult, XAgentError } from './host-client'
import { formatWebSearchResults, type WebSearchHostResult } from './format-results'

export const webSearchTool = tool(
  'web_search',
  `Search the web for current information and get back ranked results, each with a url, title, short snippet, and publish date.

Use this to look up recent or external information you do not already know. Read the snippets to judge which results are worth opening in full.`,
  {
    query: z.string().describe('The search query.'),
    numResults: z.number().int().positive().optional().describe('Maximum number of results to return.'),
    includeDomains: z.array(z.string()).optional().describe('Only return results from these domains.'),
    excludeDomains: z.array(z.string()).optional().describe('Exclude results from these domains.'),
    startPublishedDate: z.string().optional().describe('Only results published on or after this ISO 8601 date.'),
    endPublishedDate: z.string().optional().describe('Only results published on or before this ISO 8601 date.'),
  },
  async (args) => {
    try {
      const data = await callWebHost<WebSearchHostResult>('search', args)
      return textResult(formatWebSearchResults(data))
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Web search failed: ${msg}`, true)
    }
  },
)
