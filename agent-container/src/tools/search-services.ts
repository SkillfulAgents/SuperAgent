/**
 * Search Services Tool
 *
 * Single tool for discovering all connectable external services —
 * both OAuth (Composio) and remote MCP servers — in one unified catalog.
 * Each service lists its connection methods in priority order (OAuth first).
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { SERVICES, type Service } from './unified-services-catalog'

const PARTIAL_LIST_NOTE = `\nNote: This is a curated list of well-known services. Many more exist — if you don't find what you need, search the web for "<service name> MCP server" or use request_remote_mcp with a URL directly.`

function formatService(s: Service): string {
  const methodStrs = s.methods.map((m) => {
    if (m.type === 'oauth') return `oauth(toolkit:${m.toolkit})`
    return `mcp(${m.url}, auth:${m.authType})`
  })
  return `- **${s.displayName}** [${s.slug}] — ${s.description}\n  Methods (priority order): ${methodStrs.join(' → ')}`
}

export const searchServicesTool = tool(
  'search_services',
  `Search for connectable external services. Returns all matching services with their available connection methods listed in priority order:
  1. oauth — one-click Composio-managed OAuth (preferred when available; use request_connected_account with the toolkit slug)
  2. mcp — structured tools via a remote MCP server (fallback; use request_remote_mcp with the URL)

Always prefer OAuth over MCP when both are available — OAuth is simpler and more reliable. Only fall back to MCP if the OAuth request fails or is declined.

Call with no search term to list all services, or provide a search term to filter.`,
  {
    search: z
      .string()
      .optional()
      .describe(
        'Optional search term to filter services (matches slug, name, category, or description). Omit to list all.'
      ),
  },
  async (args) => {
    let results = SERVICES
    if (args.search) {
      const term = args.search.toLowerCase()
      results = SERVICES.filter(
        (s) =>
          s.slug.includes(term) ||
          s.displayName.toLowerCase().includes(term) ||
          s.category.toLowerCase().includes(term) ||
          s.description.toLowerCase().includes(term)
      )
    }

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No services found matching "${args.search}".${PARTIAL_LIST_NOTE}`,
          },
        ],
      }
    }

    const grouped: Record<string, Service[]> = {}
    for (const s of results) {
      if (!grouped[s.category]) grouped[s.category] = []
      grouped[s.category].push(s)
    }

    const lines: string[] = [`Found ${results.length} service(s):\n`]
    for (const [category, services] of Object.entries(grouped)) {
      lines.push(`## ${category}`)
      for (const s of services) {
        lines.push(formatService(s))
      }
      lines.push('')
    }
    lines.push(PARTIAL_LIST_NOTE)

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    }
  }
)
