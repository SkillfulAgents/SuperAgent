/**
 * Search Remote MCP Services Tool
 *
 * Lets the agent discover which remote MCP servers are commonly available
 * without the full list always being in context.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

interface McpServiceInfo {
  slug: string
  displayName: string
  description: string
  url: string
  authType: 'none' | 'oauth' | 'bearer'
  category: string
}

const SERVICES: McpServiceInfo[] = [
  // CRM & Sales
  { slug: 'attio', displayName: 'Attio', description: 'AI-native CRM — deals, tasks, lists, people, companies', url: 'https://mcp.attio.com/mcp', authType: 'oauth', category: 'CRM & Sales' },
  { slug: 'close', displayName: 'Close CRM', description: 'Sales CRM — leads, contacts, opportunities, activities', url: 'https://mcp.close.com/mcp', authType: 'oauth', category: 'CRM & Sales' },
  { slug: 'intercom', displayName: 'Intercom', description: 'Customer support — conversations, contacts, tickets', url: 'https://mcp.intercom.com/mcp', authType: 'oauth', category: 'CRM & Sales' },
  // Project Management
  { slug: 'linear', displayName: 'Linear', description: 'Engineering project management — issues, projects, milestones', url: 'https://mcp.linear.app/mcp', authType: 'oauth', category: 'Project Management' },
  { slug: 'atlassian', displayName: 'Atlassian (Jira/Confluence)', description: 'Jira issues, Confluence pages, JSM', url: 'https://mcp.atlassian.com/v1/mcp', authType: 'oauth', category: 'Project Management' },
  { slug: 'notion', displayName: 'Notion', description: 'Pages, docs, databases, tasks, universal search', url: 'https://mcp.notion.com/mcp', authType: 'oauth', category: 'Project Management' },
  { slug: 'clickup', displayName: 'ClickUp', description: 'Tasks, lists, folders, spaces, docs, time tracking', url: 'https://mcp.clickup.com/mcp', authType: 'oauth', category: 'Project Management' },
  { slug: 'airtable', displayName: 'Airtable', description: 'Record CRUD, base/table listing, search, schema inspection', url: 'https://mcp.airtable.com/mcp', authType: 'none', category: 'Project Management' },
  // Communication
  { slug: 'granola', displayName: 'Granola', description: 'AI meeting notes — search meetings, topics, action items', url: 'https://mcp.granola.ai/mcp', authType: 'oauth', category: 'Communication' },
  // Developer Tools
  { slug: 'sentry', displayName: 'Sentry', description: 'Error monitoring — issues, stack traces, AI analysis', url: 'https://mcp.sentry.dev/mcp', authType: 'oauth', category: 'Developer Tools' },
  { slug: 'cloudflare', displayName: 'Cloudflare API', description: 'Full Cloudflare API — 2,500+ endpoints', url: 'https://mcp.cloudflare.com/mcp', authType: 'oauth', category: 'Developer Tools' },
  { slug: 'supabase', displayName: 'Supabase', description: 'Database access and platform integration', url: 'https://mcp.supabase.com/mcp', authType: 'oauth', category: 'Developer Tools' },
  { slug: 'prisma', displayName: 'Prisma', description: 'Database management via Prisma ORM', url: 'https://mcp.prisma.io/mcp', authType: 'oauth', category: 'Developer Tools' },
  // Payments & Finance
  { slug: 'stripe', displayName: 'Stripe', description: 'Payments, customers, subscriptions, invoices', url: 'https://mcp.stripe.com/', authType: 'oauth', category: 'Payments & Finance' },
  { slug: 'paypal', displayName: 'PayPal', description: 'Commerce, payments, inventory, shipping, refunds', url: 'https://mcp.paypal.com/mcp', authType: 'oauth', category: 'Payments & Finance' },
  // Analytics & Marketing
  { slug: 'amplitude', displayName: 'Amplitude', description: 'Charts, dashboards, experiments, feature flags', url: 'https://mcp.amplitude.com/mcp', authType: 'oauth', category: 'Analytics & Marketing' },
  // Documents & Content
  // Search & AI
  { slug: 'exa', displayName: 'Exa Search', description: 'AI-powered web search', url: 'https://mcp.exa.ai/mcp', authType: 'none', category: 'Search & AI' },
  { slug: 'jina', displayName: 'Jina AI', description: 'Web search, URL-to-markdown, embeddings, PDF extraction', url: 'https://mcp.jina.ai/v1', authType: 'none', category: 'Search & AI' },
  { slug: 'deepwiki', displayName: 'DeepWiki', description: 'AI-powered GitHub repo documentation search', url: 'https://mcp.deepwiki.com/mcp', authType: 'none', category: 'Search & AI' },
  { slug: 'huggingface', displayName: 'Hugging Face', description: 'ML models, datasets, Gradio apps from HF Hub', url: 'https://hf.co/mcp', authType: 'none', category: 'Search & AI' },
  { slug: 'context7', displayName: 'Context7', description: 'Up-to-date library/framework docs (9,000+ libraries)', url: 'https://mcp.context7.com/mcp', authType: 'none', category: 'Search & AI' },
  // Aggregators
  { slug: 'waystation', displayName: 'WayStation', description: 'Universal connector for Notion, Slack, Monday, Airtable', url: 'https://waystation.ai/mcp', authType: 'oauth', category: 'Aggregators' },
]

const PARTIAL_LIST_NOTE = `\nNote: This is a partial list of well-known MCP servers. Many more exist — if you don't find what you need here, search the web for "<service name> MCP server" to find additional endpoints.`

export const searchRemoteMcpServicesTool = tool(
  'search_remote_mcp_services',
  `Search for well-known remote MCP servers that can be connected via the request_remote_mcp tool. Call with no search term to list all known servers, or provide a search term to filter by name, category, or description. This is a partial directory — if you don't find the service you need, search the web.`,
  {
    search: z
      .string()
      .optional()
      .describe(
        'Optional search term to filter MCP servers (matches name, slug, category, or description). Omit to list all.'
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
        lines.push(`- **${s.displayName}** (${s.url}) [${s.authType}] — ${s.description}`)
      }
      lines.push('')
    }
    lines.push(
      'Use request_remote_mcp with the URL and authHint to connect to a server.'
    )
    lines.push(PARTIAL_LIST_NOTE)

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    }
  }
)
