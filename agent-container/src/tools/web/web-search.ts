import { tool } from '@anthropic-ai/claude-agent-sdk'
import { handleWebSearch, webSearchInputSchema } from './web-search-handler'

export const webSearchTool = tool(
  'web_search',
  `Search the web for current information and get back ranked results, each with a url, title, short snippet, and publish date.

Use this to look up recent or external information you do not already know. Read the snippets to judge which results are worth opening in full.`,
  webSearchInputSchema.shape,
  handleWebSearch,
)
