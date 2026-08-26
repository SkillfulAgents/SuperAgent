/**
 * The remote MCP servers the agent can discover, as plain data.
 *
 * Deliberately a CURATED SUBSET of the host catalog in
 * src/shared/lib/mcp/common-servers.ts — the full list is far too long to keep in
 * the model's context, which is what PARTIAL_LIST_NOTE tells it.
 *
 * It is a hand-maintained copy because the container builds with plain `tsc` and
 * cannot import from @shared. That copying is exactly how the two lists drifted
 * before, so the invariants that keep them honest are asserted by
 * src/shared/lib/mcp/agent-catalog-parity.test.ts on the host side. Kept free of
 * imports so that test can read it without pulling in the agent SDK.
 */

export interface McpServiceInfo {
  slug: string
  displayName: string
  description: string
  url: string
  authType: 'none' | 'oauth' | 'bearer'
  category: string
  /**
   * The server rejects dynamic client registration, so the user must register an
   * OAuth app in the provider's console and allowlist our callback before this
   * can connect. Surfaced to the model so it can warn the user up front rather
   * than letting them discover it inside the approval prompt.
   *
   * Kept in step with the `setup.requiresClientId` flag on the host catalog
   * (src/shared/lib/mcp/common-servers.ts); the container cannot import from
   * @shared, which is why this list is a copy at all.
   */
  requiresOwnOAuthApp?: boolean
}

export const MCP_SERVICES: McpServiceInfo[] = [
  // CRM & Sales
  { slug: 'attio', displayName: 'Attio', description: 'AI-native CRM — deals, tasks, lists, people, companies', url: 'https://mcp.attio.com/mcp', authType: 'oauth', category: 'CRM & Sales' },
  { slug: 'close', displayName: 'Close CRM', description: 'Sales CRM — leads, contacts, opportunities, activities', url: 'https://mcp.close.com/mcp', authType: 'oauth', category: 'CRM & Sales' },
  { slug: 'intercom', displayName: 'Intercom', description: 'Customer support — conversations, contacts, tickets', url: 'https://mcp.intercom.com/mcp', authType: 'oauth', category: 'CRM & Sales' },
  // Project Management
  { slug: 'linear', displayName: 'Linear', description: 'Engineering project management — issues, projects, milestones', url: 'https://mcp.linear.app/mcp', authType: 'oauth', category: 'Project Management' },
  { slug: 'atlassian', displayName: 'Atlassian (Jira/Confluence)', description: 'Jira issues, Confluence pages, JSM', url: 'https://mcp.atlassian.com/v1/mcp', authType: 'oauth', category: 'Project Management' },
  { slug: 'notion', displayName: 'Notion', description: 'Pages, docs, databases, tasks, universal search', url: 'https://mcp.notion.com/mcp', authType: 'oauth', category: 'Project Management' },
  { slug: 'clickup', displayName: 'ClickUp', description: 'Tasks, lists, folders, spaces, docs, time tracking', url: 'https://mcp.clickup.com/mcp', authType: 'oauth', category: 'Project Management' },
  { slug: 'monday', displayName: 'Monday.com', description: 'Board management, item operations, GraphQL access', url: 'https://mcp.monday.com/mcp', authType: 'oauth', category: 'Project Management' },
  { slug: 'airtable', displayName: 'Airtable', description: 'Record CRUD, base/table listing, search, schema inspection', url: 'https://mcp.airtable.com/mcp', authType: 'none', category: 'Project Management' },
  // Communication
  { slug: 'granola', displayName: 'Granola', description: 'AI meeting notes — search meetings, topics, action items', url: 'https://mcp.granola.ai/mcp', authType: 'oauth', category: 'Communication' },
  // Developer Tools
  { slug: 'sentry', displayName: 'Sentry', description: 'Error monitoring — issues, stack traces, AI analysis', url: 'https://mcp.sentry.dev/mcp', authType: 'oauth', category: 'Developer Tools' },
  { slug: 'vercel', displayName: 'Vercel', description: 'Deployments, environment variables, domains, project controls', url: 'https://mcp.vercel.com/', authType: 'oauth', category: 'Developer Tools' },
  { slug: 'cloudflare', displayName: 'Cloudflare API', description: 'Full Cloudflare API — 2,500+ endpoints', url: 'https://mcp.cloudflare.com/mcp', authType: 'oauth', category: 'Developer Tools' },
  { slug: 'neon', displayName: 'Neon', description: 'Serverless PostgreSQL database management', url: 'https://mcp.neon.tech/sse', authType: 'oauth', category: 'Developer Tools' },
  { slug: 'supabase', displayName: 'Supabase', description: 'Database access and platform integration', url: 'https://mcp.supabase.com/mcp', authType: 'oauth', category: 'Developer Tools' },
  { slug: 'prisma', displayName: 'Prisma', description: 'Database management via Prisma ORM', url: 'https://mcp.prisma.io/mcp', authType: 'oauth', category: 'Developer Tools' },
  { slug: 'figma', displayName: 'Figma', description: 'Design context extraction, code generation from frames', url: 'https://mcp.figma.com/mcp', authType: 'oauth', category: 'Developer Tools' },
  { slug: 'semgrep', displayName: 'Semgrep', description: 'Code vulnerability and security scanning', url: 'https://mcp.semgrep.ai/mcp', authType: 'oauth', category: 'Developer Tools' },
  // Payments & Finance
  { slug: 'stripe', displayName: 'Stripe', description: 'Payments, customers, subscriptions, invoices', url: 'https://mcp.stripe.com/', authType: 'oauth', category: 'Payments & Finance' },
  { slug: 'paypal', displayName: 'PayPal', description: 'Commerce, payments, inventory, shipping, refunds', url: 'https://mcp.paypal.com/mcp', authType: 'oauth', category: 'Payments & Finance' },
  { slug: 'square', displayName: 'Square', description: 'Payments, orders, inventory, customer management', url: 'https://mcp.squareup.com/sse', authType: 'oauth', category: 'Payments & Finance' },
  { slug: 'plaid', displayName: 'Plaid', description: 'Financial data — Link analytics, usage metrics', url: 'https://api.dashboard.plaid.com/mcp/sse', authType: 'oauth', category: 'Payments & Finance' },
  { slug: 'ramp', displayName: 'Ramp', description: 'Corporate card and expense management', url: 'https://ramp-mcp-remote.ramp.com/mcp', authType: 'oauth', category: 'Payments & Finance' },
  // Analytics & Marketing
  { slug: 'amplitude', displayName: 'Amplitude', description: 'Charts, dashboards, experiments, feature flags', url: 'https://mcp.amplitude.com/mcp', authType: 'oauth', category: 'Analytics & Marketing' },
  { slug: 'meta-ads-official', displayName: 'Meta Ads (Official)', description: "Facebook and Instagram ad campaign management through Meta's official MCP server", url: 'https://mcp.facebook.com/ads', authType: 'oauth', category: 'Analytics & Marketing', requiresOwnOAuthApp: true },
  { slug: 'meta-ads', displayName: 'Meta Ads (Pipeboard)', description: 'Facebook/Instagram ad campaign management', url: 'https://mcp.pipeboard.co/meta-ads-mcp', authType: 'oauth', category: 'Analytics & Marketing' },
  { slug: 'tiktok-ads', displayName: 'TikTok Ads (Full)', description: 'Campaign management, reporting, audiences, and creative — full ~400-tool set (recommended for Claude)', url: 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat', authType: 'oauth', category: 'Analytics & Marketing' },
  { slug: 'tiktok-ads-progressive', displayName: 'TikTok Ads (Progressive)', description: 'Campaign management with ~40 core tools loaded upfront and additional tools discovered on demand', url: 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer', authType: 'oauth', category: 'Analytics & Marketing' },
  // Documents & Content
  { slug: 'dropbox', displayName: 'Dropbox', description: 'File operations — list, search, download, upload', url: 'https://mcp.dropbox.com/mcp', authType: 'oauth', category: 'Documents & Content' },
  { slug: 'canva', displayName: 'Canva', description: 'Design — search, create, autofill templates, export', url: 'https://mcp.canva.com/mcp', authType: 'oauth', category: 'Documents & Content' },
  // Search & AI
  { slug: 'exa', displayName: 'Exa Search', description: 'AI-powered web search', url: 'https://mcp.exa.ai/mcp', authType: 'none', category: 'Search & AI' },
  { slug: 'jina', displayName: 'Jina AI', description: 'Web search, URL-to-markdown, embeddings, PDF extraction', url: 'https://mcp.jina.ai/v1', authType: 'none', category: 'Search & AI' },
  { slug: 'deepwiki', displayName: 'DeepWiki', description: 'AI-powered GitHub repo documentation search', url: 'https://mcp.deepwiki.com/mcp', authType: 'none', category: 'Search & AI' },
  { slug: 'huggingface', displayName: 'Hugging Face', description: 'ML models, datasets, Gradio apps from HF Hub', url: 'https://hf.co/mcp', authType: 'none', category: 'Search & AI' },
  { slug: 'context7', displayName: 'Context7', description: 'Up-to-date library/framework docs (9,000+ libraries)', url: 'https://mcp.context7.com/mcp', authType: 'none', category: 'Search & AI' },
  // Aggregators
  { slug: 'zapier', displayName: 'Zapier', description: 'Workflow automation across 7,000+ apps', url: 'https://mcp.zapier.com/api/mcp/mcp', authType: 'bearer', category: 'Aggregators' },
  { slug: 'waystation', displayName: 'WayStation', description: 'Universal connector for Notion, Slack, Monday, Airtable', url: 'https://waystation.ai/mcp', authType: 'oauth', category: 'Aggregators' },
]
