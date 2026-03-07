/**
 * Common remote MCP servers directory.
 * This is the master list of well-known MCP servers that users can connect.
 */

export interface CommonMcpServer {
  slug: string
  displayName: string
  description: string
  url: string
  authType: 'none' | 'oauth' | 'bearer'
  category: string
}

export const COMMON_MCP_SERVERS: CommonMcpServer[] = [
  // CRM, Sales & Customer Support
  {
    slug: 'attio',
    displayName: 'Attio',
    description: 'AI-native CRM — deals, tasks, lists, people, companies',
    url: 'https://mcp.attio.com/mcp',
    authType: 'oauth',
    category: 'CRM & Sales',
  },
  {
    slug: 'close',
    displayName: 'Close CRM',
    description: 'Sales CRM — leads, contacts, opportunities, activities',
    url: 'https://mcp.close.com/mcp',
    authType: 'oauth',
    category: 'CRM & Sales',
  },
  {
    slug: 'intercom',
    displayName: 'Intercom',
    description: 'Customer support — conversations, contacts, tickets',
    url: 'https://mcp.intercom.com/mcp',
    authType: 'oauth',
    category: 'CRM & Sales',
  },

  // Project Management & Productivity
  {
    slug: 'linear',
    displayName: 'Linear',
    description: 'Engineering project management — issues, projects, milestones',
    url: 'https://mcp.linear.app/mcp',
    authType: 'oauth',
    category: 'Project Management',
  },
  {
    slug: 'atlassian',
    displayName: 'Atlassian (Jira/Confluence)',
    description: 'Jira issues, Confluence pages, JSM',
    url: 'https://mcp.atlassian.com/v1/mcp',
    authType: 'oauth',
    category: 'Project Management',
  },
  {
    slug: 'notion',
    displayName: 'Notion',
    description: 'Pages, docs, databases, tasks, universal search',
    url: 'https://mcp.notion.com/mcp',
    authType: 'oauth',
    category: 'Project Management',
  },
  {
    slug: 'clickup',
    displayName: 'ClickUp',
    description: 'Tasks, lists, folders, spaces, docs, time tracking',
    url: 'https://mcp.clickup.com/mcp',
    authType: 'oauth',
    category: 'Project Management',
  },
  {
    slug: 'monday',
    displayName: 'Monday.com',
    description: 'Board management, item operations, GraphQL access',
    url: 'https://mcp.monday.com/mcp',
    authType: 'oauth',
    category: 'Project Management',
  },
  {
    slug: 'airtable',
    displayName: 'Airtable',
    description: 'Record CRUD, base/table listing, search, schema inspection',
    url: 'https://mcp.airtable.com/mcp',
    authType: 'none',
    category: 'Project Management',
  },
  {
    slug: 'webflow',
    displayName: 'Webflow',
    description: 'CMS management, SEO, content localization, publishing',
    url: 'https://mcp.webflow.com/sse',
    authType: 'oauth',
    category: 'Project Management',
  },
  {
    slug: 'wix',
    displayName: 'Wix',
    description: 'Website builder and content management',
    url: 'https://mcp.wix.com/sse',
    authType: 'oauth',
    category: 'Project Management',
  },

  // Communication & Meetings
  {
    slug: 'granola',
    displayName: 'Granola',
    description: 'AI meeting notes — search meetings, topics, action items',
    url: 'https://mcp.granola.ai/mcp',
    authType: 'oauth',
    category: 'Communication',
  },
  {
    slug: 'telnyx',
    displayName: 'Telnyx',
    description: 'Communications API — voice, SMS, messaging',
    url: 'https://api.telnyx.com/v2/mcp',
    authType: 'bearer',
    category: 'Communication',
  },
  {
    slug: 'dialer',
    displayName: 'Dialer',
    description: 'Outbound phone calls',
    url: 'https://getdialer.app/sse',
    authType: 'oauth',
    category: 'Communication',
  },

  // Developer Tools & Infrastructure
  {
    slug: 'sentry',
    displayName: 'Sentry',
    description: 'Error monitoring — issues, stack traces, AI analysis',
    url: 'https://mcp.sentry.dev/mcp',
    authType: 'oauth',
    category: 'Developer Tools',
  },
  {
    slug: 'vercel',
    displayName: 'Vercel',
    description: 'Deployments, environment variables, domains, project controls',
    url: 'https://mcp.vercel.com/',
    authType: 'oauth',
    category: 'Developer Tools',
  },
  {
    slug: 'cloudflare',
    displayName: 'Cloudflare API',
    description: 'Full Cloudflare API — 2,500+ endpoints via Code Mode',
    url: 'https://mcp.cloudflare.com/mcp',
    authType: 'oauth',
    category: 'Developer Tools',
  },
  {
    slug: 'cloudflare-workers',
    displayName: 'Cloudflare Workers',
    description: 'Build Workers apps with KV/R2/D1/AI',
    url: 'https://bindings.mcp.cloudflare.com/sse',
    authType: 'oauth',
    category: 'Developer Tools',
  },
  {
    slug: 'cloudflare-observability',
    displayName: 'Cloudflare Observability',
    description: 'Debug apps via logs and analytics',
    url: 'https://observability.mcp.cloudflare.com/sse',
    authType: 'oauth',
    category: 'Developer Tools',
  },
  {
    slug: 'cloudflare-radar',
    displayName: 'Cloudflare Radar',
    description: 'Global internet traffic insights',
    url: 'https://radar.mcp.cloudflare.com/mcp',
    authType: 'oauth',
    category: 'Developer Tools',
  },
  {
    slug: 'neon',
    displayName: 'Neon',
    description: 'Serverless PostgreSQL database management',
    url: 'https://mcp.neon.tech/sse',
    authType: 'oauth',
    category: 'Developer Tools',
  },
  {
    slug: 'supabase',
    displayName: 'Supabase',
    description: 'Database access and platform integration',
    url: 'https://mcp.supabase.com/mcp',
    authType: 'oauth',
    category: 'Developer Tools',
  },
  {
    slug: 'buildkite',
    displayName: 'Buildkite',
    description: 'CI/CD pipelines',
    url: 'https://mcp.buildkite.com/mcp',
    authType: 'oauth',
    category: 'Developer Tools',
  },
  {
    slug: 'prisma',
    displayName: 'Prisma',
    description: 'Database management via Prisma ORM',
    url: 'https://mcp.prisma.io/mcp',
    authType: 'oauth',
    category: 'Developer Tools',
  },
  {
    slug: 'figma',
    displayName: 'Figma',
    description: 'Design context extraction, code generation from frames',
    url: 'https://mcp.figma.com/mcp',
    authType: 'oauth',
    category: 'Developer Tools',
  },
  {
    slug: 'datadog',
    displayName: 'Datadog',
    description: 'Logs, traces, incidents, monitors, dashboards, metrics',
    url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',
    authType: 'bearer',
    category: 'Developer Tools',
  },
  {
    slug: 'semgrep',
    displayName: 'Semgrep',
    description: 'Code vulnerability and security scanning',
    url: 'https://mcp.semgrep.ai/mcp',
    authType: 'oauth',
    category: 'Developer Tools',
  },
  {
    slug: 'jam',
    displayName: 'Jam',
    description: 'Bug reporting for dev teams',
    url: 'https://mcp.jam.dev/mcp',
    authType: 'oauth',
    category: 'Developer Tools',
  },
  {
    slug: 'grafbase',
    displayName: 'Grafbase',
    description: 'GraphQL API platform',
    url: 'https://api.grafbase.com/mcp',
    authType: 'oauth',
    category: 'Developer Tools',
  },
  {
    slug: 'cortex',
    displayName: 'Cortex',
    description: 'Internal developer portal',
    url: 'https://mcp.cortex.io/mcp',
    authType: 'bearer',
    category: 'Developer Tools',
  },
  {
    slug: 'stytch',
    displayName: 'Stytch',
    description: 'Authentication platform',
    url: 'http://mcp.stytch.dev/mcp',
    authType: 'oauth',
    category: 'Developer Tools',
  },

  // Payments, Finance & Commerce
  {
    slug: 'stripe',
    displayName: 'Stripe',
    description: 'Payments, customers, subscriptions, invoices, fraud detection',
    url: 'https://mcp.stripe.com/',
    authType: 'oauth',
    category: 'Payments & Finance',
  },
  {
    slug: 'paypal',
    displayName: 'PayPal',
    description: 'Commerce, payments, inventory, shipping, refunds',
    url: 'https://mcp.paypal.com/mcp',
    authType: 'oauth',
    category: 'Payments & Finance',
  },
  {
    slug: 'square',
    displayName: 'Square',
    description: 'Payments, orders, inventory, customer management',
    url: 'https://mcp.squareup.com/sse',
    authType: 'oauth',
    category: 'Payments & Finance',
  },
  {
    slug: 'plaid',
    displayName: 'Plaid',
    description: 'Financial data — Link analytics, usage metrics',
    url: 'https://api.dashboard.plaid.com/mcp/sse',
    authType: 'oauth',
    category: 'Payments & Finance',
  },
  {
    slug: 'ramp',
    displayName: 'Ramp',
    description: 'Corporate card and expense management',
    url: 'https://ramp-mcp-remote.ramp.com/mcp',
    authType: 'oauth',
    category: 'Payments & Finance',
  },
  {
    slug: 'morningstar',
    displayName: 'Morningstar',
    description: 'Financial data analysis and research',
    url: 'https://mcp.morningstar.com/mcp',
    authType: 'oauth',
    category: 'Payments & Finance',
  },
  {
    slug: 'dodo-payments',
    displayName: 'Dodo Payments',
    description: 'Payment processing',
    url: 'https://mcp.dodopayments.com/sse',
    authType: 'bearer',
    category: 'Payments & Finance',
  },
  {
    slug: 'mercadolibre',
    displayName: 'Mercado Libre',
    description: 'E-commerce marketplace (Latin America)',
    url: 'https://mcp.mercadolibre.com/mcp',
    authType: 'bearer',
    category: 'Payments & Finance',
  },
  {
    slug: 'mercadopago',
    displayName: 'Mercado Pago',
    description: 'Payment processing (Latin America)',
    url: 'https://mcp.mercadopago.com/mcp',
    authType: 'bearer',
    category: 'Payments & Finance',
  },

  // Analytics, Marketing & SEO
  {
    slug: 'amplitude',
    displayName: 'Amplitude',
    description: 'Charts, dashboards, experiments, feature flags, cohorts',
    url: 'https://mcp.amplitude.com/mcp',
    authType: 'oauth',
    category: 'Analytics & Marketing',
  },
  {
    slug: 'thoughtspot',
    displayName: 'ThoughtSpot',
    description: 'Data analytics and business intelligence',
    url: 'https://agent.thoughtspot.app/mcp',
    authType: 'oauth',
    category: 'Analytics & Marketing',
  },
  {
    slug: 'meta-ads',
    displayName: 'Meta Ads (Pipeboard)',
    description: 'Facebook/Instagram ad campaign management',
    url: 'https://mcp.pipeboard.co/meta-ads-mcp',
    authType: 'oauth',
    category: 'Analytics & Marketing',
  },

  // Document Management & Content
  {
    slug: 'dropbox',
    displayName: 'Dropbox',
    description: 'File operations — list, search, download, upload',
    url: 'https://mcp.dropbox.com/mcp',
    authType: 'oauth',
    category: 'Documents & Content',
  },
  {
    slug: 'egnyte',
    displayName: 'Egnyte',
    description: 'Enterprise content management — document Q&A, summarization',
    url: 'https://mcp-server.egnyte.com/sse',
    authType: 'oauth',
    category: 'Documents & Content',
  },
  {
    slug: 'canva',
    displayName: 'Canva',
    description: 'Design — search, create, autofill templates, export',
    url: 'https://mcp.canva.com/mcp',
    authType: 'oauth',
    category: 'Documents & Content',
  },
  {
    slug: 'cloudinary',
    displayName: 'Cloudinary',
    description: 'Digital asset management',
    url: 'https://asset-management.mcp.cloudinary.com/sse',
    authType: 'oauth',
    category: 'Documents & Content',
  },

  // Search, Web Data & AI Tools
  {
    slug: 'exa',
    displayName: 'Exa Search',
    description: 'AI-powered web search',
    url: 'https://mcp.exa.ai/mcp',
    authType: 'none',
    category: 'Search & AI',
  },
  {
    slug: 'jina',
    displayName: 'Jina AI',
    description: 'Web search, URL-to-markdown, embeddings, PDF extraction',
    url: 'https://mcp.jina.ai/v1',
    authType: 'none',
    category: 'Search & AI',
  },
  {
    slug: 'apify',
    displayName: 'Apify',
    description: '4,000+ web scraping and automation actors',
    url: 'https://mcp.apify.com',
    authType: 'bearer',
    category: 'Search & AI',
  },
  {
    slug: 'deepwiki',
    displayName: 'DeepWiki',
    description: 'AI-powered GitHub repo documentation search',
    url: 'https://mcp.deepwiki.com/mcp',
    authType: 'none',
    category: 'Search & AI',
  },
  {
    slug: 'huggingface',
    displayName: 'Hugging Face',
    description: 'ML models, datasets, Gradio apps from HF Hub',
    url: 'https://hf.co/mcp',
    authType: 'none',
    category: 'Search & AI',
  },
  {
    slug: 'aws-knowledge',
    displayName: 'AWS Knowledge',
    description: 'AWS documentation search and recommendations',
    url: 'https://knowledge-mcp.global.api.aws',
    authType: 'none',
    category: 'Search & AI',
  },
  {
    slug: 'context7',
    displayName: 'Context7',
    description: 'Up-to-date library/framework docs (9,000+ libraries)',
    url: 'https://mcp.context7.com/mcp',
    authType: 'none',
    category: 'Search & AI',
  },
  {
    slug: 'microsoft-learn',
    displayName: 'Microsoft Learn',
    description: 'Microsoft documentation search',
    url: 'https://learn.microsoft.com/api/mcp',
    authType: 'none',
    category: 'Search & AI',
  },
  {
    slug: 'tally',
    displayName: 'Tally',
    description: 'Form building via natural language',
    url: 'https://api.tally.so/mcp',
    authType: 'bearer',
    category: 'Search & AI',
  },

  // Aggregator Platforms
  {
    slug: 'zapier',
    displayName: 'Zapier',
    description: 'Workflow automation across 7,000+ apps',
    url: 'https://mcp.zapier.com/api/mcp/mcp',
    authType: 'bearer',
    category: 'Aggregators',
  },
  {
    slug: 'waystation',
    displayName: 'WayStation',
    description: 'Universal connector for Notion, Slack, Monday, Airtable',
    url: 'https://waystation.ai/mcp',
    authType: 'oauth',
    category: 'Aggregators',
  },

  // Other
  {
    slug: 'indeed',
    displayName: 'Indeed',
    description: 'Job board — search and access job listings',
    url: 'https://mcp.indeed.com/claude/mcp',
    authType: 'oauth',
    category: 'Other',
  },
  {
    slug: 'backdocket',
    displayName: 'Backdocket',
    description: 'Legal data — claims, matters, contacts, tasks',
    url: 'https://ai.backdocket.com/mcp',
    authType: 'oauth',
    category: 'Other',
  },
  {
    slug: 'peek',
    displayName: 'Peek.com',
    description: 'Activities and tours booking',
    url: 'https://mcp.peek.com',
    authType: 'none',
    category: 'Other',
  },
  {
    slug: 'ean-search',
    displayName: 'EAN-Search',
    description: 'Product barcode and data lookup',
    url: 'https://www.ean-search.org/mcp',
    authType: 'oauth',
    category: 'Other',
  },
  {
    slug: 'globalping',
    displayName: 'Globalping',
    description: 'Network diagnostics from 500+ locations',
    url: 'https://mcp.globalping.dev/sse',
    authType: 'oauth',
    category: 'Other',
  },
  {
    slug: 'short-io',
    displayName: 'Short.io',
    description: 'Link shortening service',
    url: 'https://ai-assistant.short.io/mcp',
    authType: 'bearer',
    category: 'Other',
  },
]

export function getCommonMcpServer(slug: string): CommonMcpServer | undefined {
  return COMMON_MCP_SERVERS.find((s) => s.slug === slug)
}

export function getAllCommonMcpServers(): CommonMcpServer[] {
  return COMMON_MCP_SERVERS
}

export function searchCommonMcpServers(query: string): CommonMcpServer[] {
  const term = query.toLowerCase()
  return COMMON_MCP_SERVERS.filter(
    (s) =>
      s.slug.includes(term) ||
      s.displayName.toLowerCase().includes(term) ||
      s.category.toLowerCase().includes(term) ||
      s.description.toLowerCase().includes(term)
  )
}
