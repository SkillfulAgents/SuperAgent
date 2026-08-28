/**
 * Search Remote MCP Services Tool
 *
 * Lets the agent discover which remote MCP servers are commonly available
 * without the full list always being in context.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import { MCP_SERVICES, type McpServiceInfo } from './mcp-service-catalog'


const PARTIAL_LIST_NOTE = `\nNote: This is a partial list of well-known MCP servers. Many more exist — if you don't find what you need here, search the web for "<service name> MCP server" to find additional endpoints.`

export const searchRemoteMcpServicesTool = tool(
  'search_remote_mcp_services',
  `Search for well-known remote MCP servers that can be connected via the request_remote_mcp tool. Provide a search term to match on name, category, or description; call with no search term to get a category index to search within. This is a partial directory — if you don't find the service you need, search the web.`,
  {
    search: z
      .string()
      .optional()
      .describe(
        'Search term to filter MCP servers (matches name, slug, category, or description). Omit to get a category index instead.'
      ),
  },
  async (args) => {
    // A no-term call means "what is there?". Answering it with all 184 rows costs
    // ~5.5k tokens for a question a category index answers in a few hundred, and
    // every category name is itself a searchable term.
    if (!args.search) {
      const counts = new Map<string, number>()
      for (const s of MCP_SERVICES) counts.set(s.category, (counts.get(s.category) ?? 0) + 1)
      const index = [...counts.entries()].map(([category, n]) => `- ${category} (${n})`)
      const needingSetup = MCP_SERVICES.filter((s) => s.requiresOwnOAuthApp)
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `${MCP_SERVICES.length} known MCP servers, by category:`,
              '',
              ...index,
              '',
              'Search by category name, service name, or what you need it to do to see the servers and their URLs.',
              ...(needingSetup.length > 0
                ? [
                    '',
                    `Needing the user to register their own OAuth app first: ${needingSetup.map((s) => s.displayName).join(', ')}.`,
                  ]
                : []),
              PARTIAL_LIST_NOTE,
            ].join('\n'),
          },
        ],
      }
    }

    let results = MCP_SERVICES
    if (args.search) {
      const term = args.search.toLowerCase()
      results = MCP_SERVICES.filter(
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
            text: `No MCP servers found matching "${args.search}".${PARTIAL_LIST_NOTE}\n\nUse request_remote_mcp with a URL to connect to any MCP server.`,
          },
        ],
      }
    }

    const grouped: Record<string, McpServiceInfo[]> = {}
    for (const s of results) {
      if (!grouped[s.category]) grouped[s.category] = []
      grouped[s.category].push(s)
    }

    const lines: string[] = [`Found ${results.length} MCP server(s):\n`]
    for (const [category, services] of Object.entries(grouped)) {
      lines.push(`## ${category}`)
      for (const s of services) {
        const setupFlag = s.requiresOwnOAuthApp ? ' [setup required]' : ''
        lines.push(`- **${s.displayName}** (${s.url}) [${s.authType}]${setupFlag} — ${s.description}`)
      }
      lines.push('')
    }
    lines.push(
      'Use request_remote_mcp with the URL and authHint to connect to a server.'
    )
    if (results.some((s) => s.requiresOwnOAuthApp)) {
      lines.push(
        '',
        'A server marked [setup required] rejects dynamic client registration: before it can connect, the user has to register an OAuth app in that provider\'s own console, allowlist our callback URL, and supply the resulting client ID. Tell them that up front — the approval prompt walks them through the exact steps and shows the callback URL to copy. If they ask you to fetch the client ID from their console, pass it to request_remote_mcp as clientId; never ask them for a client secret.',
      )
    }
    lines.push(PARTIAL_LIST_NOTE)

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    }
  }
)
