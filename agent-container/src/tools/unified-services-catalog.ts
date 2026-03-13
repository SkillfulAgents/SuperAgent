/**
 * Unified Services Catalog
 *
 * Single source of truth for all connectable external services.
 * Each service lists available connection methods in priority order:
 *   1. oauth  — one-click, Composio-managed credentials (preferred)
 *   2. mcp    — structured tools via a remote MCP server (fallback)
 */

export type ServiceMethod =
  | { type: 'oauth'; toolkit: string }
  | { type: 'mcp'; url: string; authType: 'none' | 'oauth' | 'bearer' }

export interface Service {
  slug: string
  displayName: string
  category: string
  description: string
  methods: ServiceMethod[]
}

export const SERVICES: Service[] = [
  // ── Google Workspace ────────────────────────────────────────────────────────
  {
    slug: 'gmail',
    displayName: 'Gmail',
    category: 'Google Workspace',
    description: 'Google email service',
    methods: [{ type: 'oauth', toolkit: 'gmail' }],
  },
  {
    slug: 'googlecalendar',
    displayName: 'Google Calendar',
    category: 'Google Workspace',
    description: 'Google calendar and scheduling',
    methods: [{ type: 'oauth', toolkit: 'googlecalendar' }],
  },
  {
    slug: 'googledrive',
    displayName: 'Google Drive',
    category: 'Google Workspace',
    description: 'Google cloud storage',
    methods: [{ type: 'oauth', toolkit: 'googledrive' }],
  },
  {
    slug: 'googlesheets',
    displayName: 'Google Sheets',
    category: 'Google Workspace',
    description: 'Google spreadsheets',
    methods: [{ type: 'oauth', toolkit: 'googlesheets' }],
  },
  {
    slug: 'googledocs',
    displayName: 'Google Docs',
    category: 'Google Workspace',
    description: 'Google documents',
    methods: [{ type: 'oauth', toolkit: 'googledocs' }],
  },
  {
    slug: 'googlemeet',
    displayName: 'Google Meet',
    category: 'Google Workspace',
    description: 'Google video conferencing',
    methods: [{ type: 'oauth', toolkit: 'googlemeet' }],
  },
  {
    slug: 'googletasks',
    displayName: 'Google Tasks',
    category: 'Google Workspace',
    description: 'Google task management',
    methods: [{ type: 'oauth', toolkit: 'googletasks' }],
  },
  {
    slug: 'youtube',
    displayName: 'YouTube',
    category: 'Google Workspace',
    description: 'Video platform',
    methods: [{ type: 'oauth', toolkit: 'youtube' }],
  },

  // ── Microsoft ────────────────────────────────────────────────────────────────
  {
    slug: 'outlook',
    displayName: 'Outlook',
    category: 'Microsoft',
    description: 'Microsoft email and calendar',
    methods: [{ type: 'oauth', toolkit: 'outlook' }],
  },
  {
    slug: 'microsoft_teams',
    displayName: 'Microsoft Teams',
    category: 'Microsoft',
    description: 'Microsoft team communication',
    methods: [{ type: 'oauth', toolkit: 'microsoft_teams' }],
  },

  // ── Communication ────────────────────────────────────────────────────────────
  {
    slug: 'slack',
    displayName: 'Slack',
    category: 'Communication',
    description: 'Team communication platform',
    methods: [{ type: 'oauth', toolkit: 'slack' }],
  },
  {
    slug: 'discord',
    displayName: 'Discord',
    category: 'Communication',
    description: 'Community chat platform',
    methods: [{ type: 'oauth', toolkit: 'discord' }],
  },
  {
    slug: 'zoom',
    displayName: 'Zoom',
    category: 'Communication',
    description: 'Video conferencing',
    methods: [{ type: 'oauth', toolkit: 'zoom' }],
  },
  {
    slug: 'granola',
    displayName: 'Granola',
    category: 'Communication',
    description: 'AI meeting notes — search meetings, topics, action items',
    methods: [{ type: 'mcp', url: 'https://mcp.granola.ai/mcp', authType: 'oauth' }],
  },
  {
    slug: 'telnyx',
    displayName: 'Telnyx',
    category: 'Communication',
    description: 'Communications API — voice, SMS, messaging',
    methods: [{ type: 'mcp', url: 'https://api.telnyx.com/v2/mcp', authType: 'bearer' }],
  },
  {
    slug: 'dialer',
    displayName: 'Dialer',
    category: 'Communication',
    description: 'Outbound phone calls',
    methods: [{ type: 'mcp', url: 'https://getdialer.app/sse', authType: 'oauth' }],
  },

  // ── Developer Tools ──────────────────────────────────────────────────────────
  {
    slug: 'github',
    displayName: 'GitHub',
    category: 'Developer Tools',
    description: 'Code repository and collaboration',
    methods: [{ type: 'oauth', toolkit: 'github' }],
  },
  {
    slug: 'gitlab',
    displayName: 'GitLab',
    category: 'Developer Tools',
    description: 'Code repository and CI/CD',
    methods: [{ type: 'oauth', toolkit: 'gitlab' }],
  },
  {
    slug: 'bitbucket',
    displayName: 'Bitbucket',
    category: 'Developer Tools',
    description: 'Code repository and pipelines',
    methods: [{ type: 'oauth', toolkit: 'bitbucket' }],
  },
  {
    slug: 'sentry',
    displayName: 'Sentry',
    category: 'Developer Tools',
    description: 'Error monitoring — issues, stack traces, AI analysis',
    methods: [
      { type: 'oauth', toolkit: 'sentry' },
      { type: 'mcp', url: 'https://mcp.sentry.dev/mcp', authType: 'oauth' },
    ],
  },
  {
    slug: 'cloudflare',
    displayName: 'Cloudflare API',
    category: 'Developer Tools',
    description: 'Full Cloudflare API — 2,500+ endpoints via Code Mode',
    methods: [{ type: 'mcp', url: 'https://mcp.cloudflare.com/mcp', authType: 'oauth' }],
  },
  {
    slug: 'cloudflare-workers',
    displayName: 'Cloudflare Workers',
    category: 'Developer Tools',
    description: 'Build Workers apps with KV/R2/D1/AI',
    methods: [{ type: 'mcp', url: 'https://bindings.mcp.cloudflare.com/sse', authType: 'oauth' }],
  },
  {
    slug: 'cloudflare-observability',
    displayName: 'Cloudflare Observability',
    category: 'Developer Tools',
    description: 'Debug apps via logs and analytics',
    methods: [{ type: 'mcp', url: 'https://observability.mcp.cloudflare.com/sse', authType: 'oauth' }],
  },
  {
    slug: 'cloudflare-radar',
    displayName: 'Cloudflare Radar',
    category: 'Developer Tools',
    description: 'Global internet traffic insights',
    methods: [{ type: 'mcp', url: 'https://radar.mcp.cloudflare.com/mcp', authType: 'oauth' }],
  },
  {
    slug: 'supabase',
    displayName: 'Supabase',
    category: 'Developer Tools',
    description: 'Database access and platform integration',
    methods: [{ type: 'mcp', url: 'https://mcp.supabase.com/mcp', authType: 'oauth' }],
  },
  {
    slug: 'buildkite',
    displayName: 'Buildkite',
    category: 'Developer Tools',
    description: 'CI/CD pipelines',
    methods: [{ type: 'mcp', url: 'https://mcp.buildkite.com/mcp', authType: 'oauth' }],
  },
  {
    slug: 'prisma',
    displayName: 'Prisma',
    category: 'Developer Tools',
    description: 'Database management via Prisma ORM',
    methods: [{ type: 'mcp', url: 'https://mcp.prisma.io/mcp', authType: 'oauth' }],
  },
  {
    slug: 'datadog',
    displayName: 'Datadog',
    category: 'Developer Tools',
    description: 'Logs, traces, incidents, monitors, dashboards, metrics',
    methods: [{ type: 'mcp', url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp', authType: 'bearer' }],
  },
  {
    slug: 'jam',
    displayName: 'Jam',
    category: 'Developer Tools',
    description: 'Bug reporting for dev teams',
    methods: [{ type: 'mcp', url: 'https://mcp.jam.dev/mcp', authType: 'oauth' }],
  },
  {
    slug: 'grafbase',
    displayName: 'Grafbase',
    category: 'Developer Tools',
    description: 'GraphQL API platform',
    methods: [{ type: 'mcp', url: 'https://api.grafbase.com/mcp', authType: 'oauth' }],
  },
  {
    slug: 'cortex',
    displayName: 'Cortex',
    category: 'Developer Tools',
    description: 'Internal developer portal',
    methods: [{ type: 'mcp', url: 'https://mcp.cortex.io/mcp', authType: 'bearer' }],
  },
  {
    slug: 'stytch',
    displayName: 'Stytch',
    category: 'Developer Tools',
    description: 'Authentication platform',
    methods: [{ type: 'mcp', url: 'http://mcp.stytch.dev/mcp', authType: 'oauth' }],
  },

  // ── Project Management ───────────────────────────────────────────────────────
  {
    slug: 'notion',
    displayName: 'Notion',
    category: 'Project Management',
    description: 'Pages, docs, databases, tasks, universal search',
    methods: [
      { type: 'oauth', toolkit: 'notion' },
      { type: 'mcp', url: 'https://mcp.notion.com/mcp', authType: 'oauth' },
    ],
  },
  {
    slug: 'linear',
    displayName: 'Linear',
    category: 'Project Management',
    description: 'Engineering project management — issues, projects, milestones',
    methods: [
      { type: 'oauth', toolkit: 'linear' },
      { type: 'mcp', url: 'https://mcp.linear.app/mcp', authType: 'oauth' },
    ],
  },
  {
    slug: 'asana',
    displayName: 'Asana',
    category: 'Project Management',
    description: 'Project and task management',
    methods: [{ type: 'oauth', toolkit: 'asana' }],
  },
  {
    slug: 'clickup',
    displayName: 'ClickUp',
    category: 'Project Management',
    description: 'Tasks, lists, folders, spaces, docs, time tracking',
    methods: [
      { type: 'oauth', toolkit: 'clickup' },
      { type: 'mcp', url: 'https://mcp.clickup.com/mcp', authType: 'oauth' },
    ],
  },
  {
    slug: 'atlassian',
    displayName: 'Atlassian (Jira/Confluence)',
    category: 'Project Management',
    description: 'Jira issues, Confluence pages, JSM',
    methods: [{ type: 'mcp', url: 'https://mcp.atlassian.com/v1/mcp', authType: 'oauth' }],
  },
  {
    slug: 'airtable',
    displayName: 'Airtable',
    category: 'Project Management',
    description: 'Record CRUD, base/table listing, search, schema inspection',
    methods: [
      { type: 'oauth', toolkit: 'airtable' },
      { type: 'mcp', url: 'https://mcp.airtable.com/mcp', authType: 'none' },
    ],
  },
  {
    slug: 'webflow',
    displayName: 'Webflow',
    category: 'Project Management',
    description: 'CMS management, SEO, content localization, publishing',
    methods: [{ type: 'mcp', url: 'https://mcp.webflow.com/sse', authType: 'oauth' }],
  },
  {
    slug: 'wix',
    displayName: 'Wix',
    category: 'Project Management',
    description: 'Website builder and content management',
    methods: [{ type: 'mcp', url: 'https://mcp.wix.com/sse', authType: 'oauth' }],
  },

  // ── CRM & Sales ──────────────────────────────────────────────────────────────
  {
    slug: 'hubspot',
    displayName: 'HubSpot',
    category: 'CRM & Sales',
    description: 'CRM and marketing platform',
    methods: [{ type: 'oauth', toolkit: 'hubspot' }],
  },
  {
    slug: 'salesforce',
    displayName: 'Salesforce',
    category: 'CRM & Sales',
    description: 'CRM and sales platform',
    methods: [{ type: 'oauth', toolkit: 'salesforce' }],
  },
  {
    slug: 'intercom',
    displayName: 'Intercom',
    category: 'CRM & Sales',
    description: 'Customer support — conversations, contacts, tickets',
    methods: [
      { type: 'oauth', toolkit: 'intercom' },
      { type: 'mcp', url: 'https://mcp.intercom.com/mcp', authType: 'oauth' },
    ],
  },
  {
    slug: 'attio',
    displayName: 'Attio',
    category: 'CRM & Sales',
    description: 'AI-native CRM — deals, tasks, lists, people, companies',
    methods: [{ type: 'mcp', url: 'https://mcp.attio.com/mcp', authType: 'oauth' }],
  },
  {
    slug: 'close',
    displayName: 'Close CRM',
    category: 'CRM & Sales',
    description: 'Sales CRM — leads, contacts, opportunities, activities',
    methods: [{ type: 'mcp', url: 'https://mcp.close.com/mcp', authType: 'oauth' }],
  },

  // ── Cloud Storage & Documents ────────────────────────────────────────────────
  {
    slug: 'dropbox',
    displayName: 'Dropbox',
    category: 'Cloud Storage & Documents',
    description: 'Cloud file storage',
    methods: [{ type: 'oauth', toolkit: 'dropbox' }],
  },
  {
    slug: 'box',
    displayName: 'Box',
    category: 'Cloud Storage & Documents',
    description: 'Cloud content management',
    methods: [{ type: 'oauth', toolkit: 'box' }],
  },
  {
    slug: 'egnyte',
    displayName: 'Egnyte',
    category: 'Cloud Storage & Documents',
    description: 'Enterprise content management — document Q&A, summarization',
    methods: [{ type: 'mcp', url: 'https://mcp-server.egnyte.com/sse', authType: 'oauth' }],
  },
  {
    slug: 'cloudinary',
    displayName: 'Cloudinary',
    category: 'Cloud Storage & Documents',
    description: 'Digital asset management',
    methods: [{ type: 'mcp', url: 'https://asset-management.mcp.cloudinary.com/sse', authType: 'oauth' }],
  },

  // ── Social Media ─────────────────────────────────────────────────────────────
  {
    slug: 'linkedin',
    displayName: 'LinkedIn',
    category: 'Social Media',
    description: 'Professional networking',
    methods: [{ type: 'oauth', toolkit: 'linkedin' }],
  },
  {
    slug: 'instagram',
    displayName: 'Instagram',
    category: 'Social Media',
    description: 'Photo and video sharing',
    methods: [{ type: 'oauth', toolkit: 'instagram' }],
  },

  // ── Finance & Payments ───────────────────────────────────────────────────────
  {
    slug: 'stripe',
    displayName: 'Stripe',
    category: 'Finance & Payments',
    description: 'Payments, customers, subscriptions, invoices, fraud detection',
    methods: [
      { type: 'oauth', toolkit: 'stripe' },
      { type: 'mcp', url: 'https://mcp.stripe.com/', authType: 'oauth' },
    ],
  },
  {
    slug: 'paypal',
    displayName: 'PayPal',
    category: 'Finance & Payments',
    description: 'Commerce, payments, inventory, shipping, refunds',
    methods: [{ type: 'mcp', url: 'https://mcp.paypal.com/mcp', authType: 'oauth' }],
  },
  {
    slug: 'quickbooks',
    displayName: 'QuickBooks',
    category: 'Finance & Payments',
    description: 'Accounting and bookkeeping',
    methods: [{ type: 'oauth', toolkit: 'quickbooks' }],
  },
  {
    slug: 'mailchimp',
    displayName: 'Mailchimp',
    category: 'Finance & Payments',
    description: 'Email marketing platform',
    methods: [{ type: 'oauth', toolkit: 'mailchimp' }],
  },
  {
    slug: 'morningstar',
    displayName: 'Morningstar',
    category: 'Finance & Payments',
    description: 'Financial data analysis and research',
    methods: [{ type: 'mcp', url: 'https://mcp.morningstar.com/mcp', authType: 'oauth' }],
  },
  {
    slug: 'dodo-payments',
    displayName: 'Dodo Payments',
    category: 'Finance & Payments',
    description: 'Payment processing',
    methods: [{ type: 'mcp', url: 'https://mcp.dodopayments.com/sse', authType: 'bearer' }],
  },
  {
    slug: 'mercadolibre',
    displayName: 'Mercado Libre',
    category: 'Finance & Payments',
    description: 'E-commerce marketplace (Latin America)',
    methods: [{ type: 'mcp', url: 'https://mcp.mercadolibre.com/mcp', authType: 'bearer' }],
  },
  {
    slug: 'mercadopago',
    displayName: 'Mercado Pago',
    category: 'Finance & Payments',
    description: 'Payment processing (Latin America)',
    methods: [{ type: 'mcp', url: 'https://mcp.mercadopago.com/mcp', authType: 'bearer' }],
  },

  // ── Analytics & Marketing ────────────────────────────────────────────────────
  {
    slug: 'amplitude',
    displayName: 'Amplitude',
    category: 'Analytics & Marketing',
    description: 'Charts, dashboards, experiments, feature flags, cohorts',
    methods: [{ type: 'mcp', url: 'https://mcp.amplitude.com/mcp', authType: 'oauth' }],
  },
  {
    slug: 'thoughtspot',
    displayName: 'ThoughtSpot',
    category: 'Analytics & Marketing',
    description: 'Data analytics and business intelligence',
    methods: [{ type: 'mcp', url: 'https://agent.thoughtspot.app/mcp', authType: 'oauth' }],
  },
  {
    slug: 'meta-ads',
    displayName: 'Meta Ads (Pipeboard)',
    category: 'Analytics & Marketing',
    description: 'Facebook/Instagram ad campaign management',
    methods: [{ type: 'mcp', url: 'https://mcp.pipeboard.co/meta-ads-mcp', authType: 'oauth' }],
  },

  // ── Design ───────────────────────────────────────────────────────────────────
  {
    slug: 'figma',
    displayName: 'Figma',
    category: 'Design',
    description: 'Collaborative design tool',
    methods: [{ type: 'oauth', toolkit: 'figma' }],
  },

  // ── Scheduling & Forms ───────────────────────────────────────────────────────
  {
    slug: 'calendly',
    displayName: 'Calendly',
    category: 'Scheduling & Forms',
    description: 'Scheduling and appointments',
    methods: [{ type: 'oauth', toolkit: 'calendly' }],
  },
  {
    slug: 'typeform',
    displayName: 'Typeform',
    category: 'Scheduling & Forms',
    description: 'Forms and surveys',
    methods: [{ type: 'oauth', toolkit: 'typeform' }],
  },
  {
    slug: 'tally',
    displayName: 'Tally',
    category: 'Scheduling & Forms',
    description: 'Form building via natural language',
    methods: [{ type: 'mcp', url: 'https://api.tally.so/mcp', authType: 'bearer' }],
  },

  // ── Search & AI ──────────────────────────────────────────────────────────────
  {
    slug: 'exa',
    displayName: 'Exa Search',
    category: 'Search & AI',
    description: 'AI-powered web search',
    methods: [{ type: 'mcp', url: 'https://mcp.exa.ai/mcp', authType: 'none' }],
  },
  {
    slug: 'jina',
    displayName: 'Jina AI',
    category: 'Search & AI',
    description: 'Web search, URL-to-markdown, embeddings, PDF extraction',
    methods: [{ type: 'mcp', url: 'https://mcp.jina.ai/v1', authType: 'none' }],
  },
  {
    slug: 'apify',
    displayName: 'Apify',
    category: 'Search & AI',
    description: '4,000+ web scraping and automation actors',
    methods: [{ type: 'mcp', url: 'https://mcp.apify.com', authType: 'bearer' }],
  },
  {
    slug: 'deepwiki',
    displayName: 'DeepWiki',
    category: 'Search & AI',
    description: 'AI-powered GitHub repo documentation search',
    methods: [{ type: 'mcp', url: 'https://mcp.deepwiki.com/mcp', authType: 'none' }],
  },
  {
    slug: 'huggingface',
    displayName: 'Hugging Face',
    category: 'Search & AI',
    description: 'ML models, datasets, Gradio apps from HF Hub',
    methods: [{ type: 'mcp', url: 'https://hf.co/mcp', authType: 'none' }],
  },
  {
    slug: 'aws-knowledge',
    displayName: 'AWS Knowledge',
    category: 'Search & AI',
    description: 'AWS documentation search and recommendations',
    methods: [{ type: 'mcp', url: 'https://knowledge-mcp.global.api.aws', authType: 'none' }],
  },
  {
    slug: 'context7',
    displayName: 'Context7',
    category: 'Search & AI',
    description: 'Up-to-date library/framework docs (9,000+ libraries)',
    methods: [{ type: 'mcp', url: 'https://mcp.context7.com/mcp', authType: 'none' }],
  },
  {
    slug: 'microsoft-learn',
    displayName: 'Microsoft Learn',
    category: 'Search & AI',
    description: 'Microsoft documentation search',
    methods: [{ type: 'mcp', url: 'https://learn.microsoft.com/api/mcp', authType: 'none' }],
  },

  // ── Aggregators ──────────────────────────────────────────────────────────────
  {
    slug: 'waystation',
    displayName: 'WayStation',
    category: 'Aggregators',
    description: 'Universal connector for Notion, Slack, Monday, Airtable',
    methods: [{ type: 'mcp', url: 'https://waystation.ai/mcp', authType: 'oauth' }],
  },

  // ── Other ────────────────────────────────────────────────────────────────────
  {
    slug: 'indeed',
    displayName: 'Indeed',
    category: 'Other',
    description: 'Job board — search and access job listings',
    methods: [{ type: 'mcp', url: 'https://mcp.indeed.com/claude/mcp', authType: 'oauth' }],
  },
  {
    slug: 'backdocket',
    displayName: 'Backdocket',
    category: 'Other',
    description: 'Legal data — claims, matters, contacts, tasks',
    methods: [{ type: 'mcp', url: 'https://ai.backdocket.com/mcp', authType: 'oauth' }],
  },
  {
    slug: 'peek',
    displayName: 'Peek.com',
    category: 'Other',
    description: 'Activities and tours booking',
    methods: [{ type: 'mcp', url: 'https://mcp.peek.com', authType: 'none' }],
  },
  {
    slug: 'ean-search',
    displayName: 'EAN-Search',
    category: 'Other',
    description: 'Product barcode and data lookup',
    methods: [{ type: 'mcp', url: 'https://www.ean-search.org/mcp', authType: 'oauth' }],
  },
  {
    slug: 'globalping',
    displayName: 'Globalping',
    category: 'Other',
    description: 'Network diagnostics from 500+ locations',
    methods: [{ type: 'mcp', url: 'https://mcp.globalping.dev/sse', authType: 'oauth' }],
  },
  {
    slug: 'short-io',
    displayName: 'Short.io',
    category: 'Other',
    description: 'Link shortening service',
    methods: [{ type: 'mcp', url: 'https://ai-assistant.short.io/mcp', authType: 'bearer' }],
  },
]
