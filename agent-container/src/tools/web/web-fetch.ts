import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callWebHost, textResult, XAgentError } from './host-client'
import { formatWebFetchResult, type WebFetchHostResult } from './format-results'

export const webFetchTool = tool(
  'web_fetch',
  `Fetch the full text content of a single web page by its URL.

Use this to read a page in full — an article, docs page, or search result you want to open. Give it one URL and you get back the page's title, publish date (when available), and extracted text.`,
  {
    url: z.string().describe('The URL of the page to fetch.'),
    maxChars: z.number().int().positive().optional().describe('Maximum number of characters of content to return.'),
  },
  async (args) => {
    try {
      const data = await callWebHost<WebFetchHostResult>('web-fetch', 'fetch', args)
      return textResult(formatWebFetchResult(data))
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Web fetch failed: ${msg}`, true)
    }
  },
)
