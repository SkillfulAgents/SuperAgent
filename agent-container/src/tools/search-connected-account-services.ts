/**
 * Search Connected Account Services Tool
 *
 * Lets the agent discover which OAuth services are available
 * without the full list always being in context.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

interface ServiceInfo {
  slug: string
  displayName: string
  category: string
  description: string
}

// Services that exist only through Gamut's Composio; the host sets this env at container start.
const GAMUT_PLATFORM_ACCOUNTS: ServiceInfo[] = [
  { slug: 'twitter', displayName: 'X', category: 'Social Media', description: 'Posts, timelines, and direct messages' },
  { slug: 'plaid', displayName: 'Plaid', category: 'Finance', description: 'Bank accounts, balances, and transactions' },
  { slug: 'highlevel', displayName: 'HighLevel', category: 'CRM & Sales', description: 'CRM: contacts, conversations, calendars' },
  { slug: 'shopify', displayName: 'Shopify', category: 'E-commerce', description: 'Online store: products, orders, customers' },
]

const ALL_SERVICES: ServiceInfo[] = [
  // Google Workspace
  { slug: 'gmail', displayName: 'Gmail', category: 'Google Workspace', description: 'Google email service' },
  { slug: 'googlecalendar', displayName: 'Google Calendar', category: 'Google Workspace', description: 'Google calendar and scheduling' },
  { slug: 'googledrive', displayName: 'Google Drive', category: 'Google Workspace', description: 'Google cloud storage' },
  { slug: 'googlesheets', displayName: 'Google Sheets', category: 'Google Workspace', description: 'Google spreadsheets' },
  { slug: 'googledocs', displayName: 'Google Docs', category: 'Google Workspace', description: 'Google documents' },
  { slug: 'googleslides', displayName: 'Google Slides', category: 'Google Workspace', description: 'Google presentations' },
  { slug: 'googlemeet', displayName: 'Google Meet', category: 'Google Workspace', description: 'Google video conferencing' },
  { slug: 'googletasks', displayName: 'Google Tasks', category: 'Google Workspace', description: 'Google task management' },
  { slug: 'youtube', displayName: 'YouTube', category: 'Google Workspace', description: 'Video platform' },
  // Microsoft
  { slug: 'outlook', displayName: 'Outlook', category: 'Microsoft', description: 'Microsoft email and calendar' },
  { slug: 'microsoft_teams', displayName: 'Microsoft Teams', category: 'Microsoft', description: 'Microsoft team communication' },
  // Communication
  { slug: 'slack', displayName: 'Slack', category: 'Communication', description: 'Team communication platform' },
  { slug: 'discord', displayName: 'Discord', category: 'Communication', description: 'Community chat platform' },
  { slug: 'zoom', displayName: 'Zoom', category: 'Communication', description: 'Video conferencing' },
  // Developer Tools
  { slug: 'github', displayName: 'GitHub', category: 'Developer Tools', description: 'Code repository and collaboration' },
  { slug: 'gitlab', displayName: 'GitLab', category: 'Developer Tools', description: 'Code repository and CI/CD' },
  { slug: 'bitbucket', displayName: 'Bitbucket', category: 'Developer Tools', description: 'Code repository and pipelines' },
  { slug: 'sentry', displayName: 'Sentry', category: 'Developer Tools', description: 'Error tracking and monitoring' },
  // Project Management
  { slug: 'notion', displayName: 'Notion', category: 'Project Management', description: 'Workspace and documentation' },
  { slug: 'linear', displayName: 'Linear', category: 'Project Management', description: 'Issue tracking and project management' },
  { slug: 'confluence', displayName: 'Confluence', category: 'Project Management', description: 'Team documentation and wiki' },
  { slug: 'asana', displayName: 'Asana', category: 'Project Management', description: 'Project and task management' },
  { slug: 'monday', displayName: 'Monday.com', category: 'Project Management', description: 'Work management platform' },
  { slug: 'clickup', displayName: 'ClickUp', category: 'Project Management', description: 'Project management and productivity' },
  { slug: 'trello', displayName: 'Trello', category: 'Project Management', description: 'Project boards and task management' },
  // CRM & Sales
  { slug: 'hubspot', displayName: 'HubSpot', category: 'CRM & Sales', description: 'CRM and marketing platform' },
  { slug: 'salesforce', displayName: 'Salesforce', category: 'CRM & Sales', description: 'CRM and sales platform' },
  { slug: 'zendesk', displayName: 'Zendesk', category: 'CRM & Sales', description: 'Customer support and ticketing' },
  { slug: 'intercom', displayName: 'Intercom', category: 'CRM & Sales', description: 'Customer messaging platform' },
  // Cloud Storage & Documents
  { slug: 'airtable', displayName: 'Airtable', category: 'Cloud Storage & Documents', description: 'Spreadsheet-database hybrid' },
  { slug: 'dropbox', displayName: 'Dropbox', category: 'Cloud Storage & Documents', description: 'Cloud file storage' },
  { slug: 'box', displayName: 'Box', category: 'Cloud Storage & Documents', description: 'Cloud content management' },
  // Social Media
  { slug: 'linkedin', displayName: 'LinkedIn', category: 'Social Media', description: 'Professional networking' },
  { slug: 'instagram', displayName: 'Instagram', category: 'Social Media', description: 'Photo and video sharing' },
  // Finance
  { slug: 'stripe', displayName: 'Stripe', category: 'Finance', description: 'Payment processing' },
  { slug: 'quickbooks', displayName: 'QuickBooks', category: 'Finance', description: 'Accounting and bookkeeping' },
  { slug: 'xero', displayName: 'Xero', category: 'Finance', description: 'Accounting software' },
  // Marketing
  { slug: 'mailchimp', displayName: 'Mailchimp', category: 'Marketing', description: 'Email marketing platform' },
  // Design
  { slug: 'figma', displayName: 'Figma', category: 'Design', description: 'Collaborative design tool' },
  { slug: 'canva', displayName: 'Canva', category: 'Design', description: 'Designs, exports, and brand templates' },
  // Scheduling & Forms
  { slug: 'calendly', displayName: 'Calendly', category: 'Scheduling & Forms', description: 'Scheduling and appointments' },
  { slug: 'typeform', displayName: 'Typeform', category: 'Scheduling & Forms', description: 'Forms and surveys' },
  // Communication — additional Composio-managed OAuth services
  { slug: 'aircall', displayName: 'Aircall', category: 'Communication', description: 'Business calls, contacts, teams, and phone numbers' },
  { slug: 'dialpad', displayName: 'Dialpad', category: 'Communication', description: 'Business phone, messaging, and contact center' },
  { slug: 'discordbot', displayName: 'Discord Bot', category: 'Communication', description: 'Discord server access through a bot' },
  { slug: 'fathom', displayName: 'Fathom', category: 'Communication', description: 'Meeting recordings, transcripts, and summaries' },
  { slug: 'roam', displayName: 'Roam', category: 'Communication', description: 'Roam HQ messaging, files, and collaboration' },
  { slug: 'slackbot', displayName: 'Slack Bot', category: 'Communication', description: 'Workspace search and history with messaging as a Slack bot' },
  { slug: 'webex', displayName: 'Webex', category: 'Communication', description: 'Meetings, messaging, and team collaboration' },
  { slug: 'whatsapp', displayName: 'WhatsApp Business', category: 'Communication', description: 'Customer messaging through the WhatsApp Business API' },
  { slug: 'zoho_mail', displayName: 'Zoho Mail', category: 'Communication', description: 'Business email and mailbox management' },
  // Hospitality — additional Composio-managed OAuth services
  { slug: 'apaleo', displayName: 'Apaleo', category: 'Hospitality', description: 'Property management, reservations, and billing' },
  // CRM & Sales — additional Composio-managed OAuth services
  { slug: 'attio', displayName: 'Attio', category: 'CRM & Sales', description: 'Customer records, relationship data, tasks, and comments' },
  { slug: 'blackbaud', displayName: 'Blackbaud', category: 'CRM & Sales', description: 'Nonprofit fundraising and donor management' },
  { slug: 'capsule_crm', displayName: 'Capsule CRM', category: 'CRM & Sales', description: 'Customer relationships, sales pipelines, and tasks' },
  { slug: 'dynamics365', displayName: 'Microsoft Dynamics 365', category: 'CRM & Sales', description: 'Business customer records and operations' },
  { slug: 'gong', displayName: 'Gong', category: 'CRM & Sales', description: 'Sales calls, transcripts, and revenue intelligence' },
  { slug: 'gorgias', displayName: 'Gorgias', category: 'CRM & Sales', description: 'E-commerce support tickets and customer conversations' },
  { slug: 'zoho', displayName: 'Zoho CRM', category: 'CRM & Sales', description: 'Customer records, sales pipelines, and CRM workflows' },
  { slug: 'zoho_bigin', displayName: 'Zoho Bigin', category: 'CRM & Sales', description: 'Small business sales pipelines and contacts' },
  { slug: 'zoho_desk', displayName: 'Zoho Desk', category: 'CRM & Sales', description: 'Support tickets and customer service' },
  // Project Management — additional Composio-managed OAuth services
  { slug: 'basecamp', displayName: 'Basecamp', category: 'Project Management', description: 'Projects, tasks, and team collaboration' },
  { slug: 'dart', displayName: 'Dart', category: 'Project Management', description: 'Projects, tasks, and team planning' },
  { slug: 'jira', displayName: 'Jira', category: 'Project Management', description: 'Issues, projects, and agile planning' },
  { slug: 'productboard', displayName: 'Productboard', category: 'Project Management', description: 'Customer feedback, features, and product roadmaps' },
  { slug: 'wrike', displayName: 'Wrike', category: 'Project Management', description: 'Projects, tasks, and team workflows' },
  // Cloud Storage & Documents — additional Composio-managed OAuth services
  { slug: 'boldsign', displayName: 'BoldSign', category: 'Cloud Storage & Documents', description: 'Electronic signatures and document signing' },
  // Scheduling & Forms — additional Composio-managed OAuth services
  { slug: 'cal', displayName: 'Cal.com', category: 'Scheduling & Forms', description: 'Booking pages, availability, and scheduling' },
  // Content & Marketing — additional Composio-managed OAuth services
  { slug: 'contentful', displayName: 'Contentful', category: 'Content & Marketing', description: 'Content management and publishing' },
  { slug: 'crowdin', displayName: 'Crowdin', category: 'Content & Marketing', description: 'Translation and localization management' },
  { slug: 'dub', displayName: 'Dub', category: 'Content & Marketing', description: 'Branded short links and link analytics' },
  { slug: 'googleads', displayName: 'Google Ads', category: 'Content & Marketing', description: 'Advertising campaigns and performance reporting' },
  { slug: 'kit', displayName: 'Kit', category: 'Content & Marketing', description: 'Creator email marketing and subscriber management' },
  { slug: 'omnisend', displayName: 'Omnisend', category: 'Content & Marketing', description: 'E-commerce email and SMS marketing' },
  { slug: 'pinterest_ads', displayName: 'Pinterest Ads', category: 'Content & Marketing', description: 'Pinterest advertising campaigns and reporting' },
  { slug: 'reddit_ads', displayName: 'Reddit Ads', category: 'Content & Marketing', description: 'Reddit advertising campaigns and account data' },
  { slug: 'tiktok_ads', displayName: 'TikTok Ads', category: 'Content & Marketing', description: 'Business advertising campaigns, creatives, and reports' },
  // Developer Tools — additional Composio-managed OAuth services
  { slug: 'daytona', displayName: 'Daytona', category: 'Developer Tools', description: 'Daytona account profile' },
  { slug: 'hugging_face', displayName: 'Hugging Face', category: 'Developer Tools', description: 'Hugging Face account profile' },
  { slug: 'pagerduty', displayName: 'PagerDuty', category: 'Developer Tools', description: 'Incident response and on-call operations' },
  { slug: 'prisma', displayName: 'Prisma', category: 'Developer Tools', description: 'Data Platform projects, environments, and database services' },
  { slug: 'stack_exchange', displayName: 'Stack Exchange', category: 'Developer Tools', description: 'Questions, answers, and communities' },
  { slug: 'supabase', displayName: 'Supabase', category: 'Developer Tools', description: 'Supabase projects and Management API operations' },
  { slug: 'wakatime', displayName: 'WakaTime', category: 'Developer Tools', description: 'Coding activity, projects, and time tracking' },
  // Events & Ticketing — additional Composio-managed OAuth services
  { slug: 'eventbrite', displayName: 'Eventbrite', category: 'Events & Ticketing', description: 'Events, tickets, and attendee management' },
  { slug: 'ticketmaster', displayName: 'Ticketmaster', category: 'Events & Ticketing', description: 'Event discovery and ticketing' },
  // Microsoft — additional Composio-managed OAuth services
  { slug: 'excel', displayName: 'Microsoft Excel', category: 'Microsoft', description: 'Workbooks in OneDrive for Business and SharePoint' },
  { slug: 'one_drive', displayName: 'OneDrive', category: 'Microsoft', description: 'Microsoft cloud files and folders' },
  { slug: 'share_point', displayName: 'SharePoint', category: 'Microsoft', description: 'Team sites, documents, and lists' },
  // Personal Productivity — additional Composio-managed OAuth services
  { slug: 'exist', displayName: 'Exist', category: 'Personal Productivity', description: 'Personal activity tracking and analytics' },
  { slug: 'harvest', displayName: 'Harvest', category: 'Personal Productivity', description: 'Time tracking, projects, and invoicing' },
  { slug: 'linkhut', displayName: 'Linkhut', category: 'Personal Productivity', description: 'Bookmarks and shared links' },
  { slug: 'pushbullet', displayName: 'Pushbullet', category: 'Personal Productivity', description: 'Notifications, links, and files across devices' },
  { slug: 'ticktick', displayName: 'TickTick', category: 'Personal Productivity', description: 'Tasks, projects, and to-do lists' },
  { slug: 'timely', displayName: 'Timely', category: 'Personal Productivity', description: 'Time tracking, projects, and timesheets' },
  { slug: 'todoist', displayName: 'Todoist', category: 'Personal Productivity', description: 'Tasks, projects, and reminders' },
  { slug: 'yandex', displayName: 'Yandex', category: 'Personal Productivity', description: 'Yandex account profile' },
  // Social Media — additional Composio-managed OAuth services
  { slug: 'facebook', displayName: 'Facebook Pages', category: 'Social Media', description: 'Facebook Pages, posts, and audience engagement' },
  { slug: 'pinterest', displayName: 'Pinterest', category: 'Social Media', description: 'Pins, boards, and visual discovery' },
  { slug: 'reddit', displayName: 'Reddit', category: 'Social Media', description: 'Communities, posts, and discussions' },
  { slug: 'twitch', displayName: 'Twitch', category: 'Social Media', description: 'Live streams, channels, and communities' },
  // Finance — additional Composio-managed OAuth services
  { slug: 'freeagent', displayName: 'FreeAgent', category: 'Finance', description: 'Small business accounting, invoices, and expenses' },
  { slug: 'freshbooks', displayName: 'FreshBooks', category: 'Finance', description: 'Invoices, expenses, and time tracking' },
  { slug: 'moneybird', displayName: 'Moneybird', category: 'Finance', description: 'Invoices, expenses, and small business accounting' },
  { slug: 'splitwise', displayName: 'Splitwise', category: 'Finance', description: 'Shared expenses, groups, and balances' },
  { slug: 'square', displayName: 'Square', category: 'Finance', description: 'Payments, orders, customers, and inventory' },
  { slug: 'ynab', displayName: 'YNAB', category: 'Finance', description: 'Budgets, accounts, and spending' },
  { slug: 'zoho_books', displayName: 'Zoho Books', category: 'Finance', description: 'Accounting, invoices, and expenses' },
  { slug: 'zoho_invoice', displayName: 'Zoho Invoice', category: 'Finance', description: 'Invoices, recurring billing, and expenses' },
  // Analytics & Data — additional Composio-managed OAuth services
  { slug: 'google_analytics', displayName: 'Google Analytics', category: 'Analytics & Data', description: 'Website and app traffic reports' },
  { slug: 'googlebigquery', displayName: 'Google BigQuery', category: 'Analytics & Data', description: 'Cloud data warehouse and SQL queries' },
  { slug: 'google_search_console', displayName: 'Google Search Console', category: 'Analytics & Data', description: 'Search performance, sitemaps, and URL inspection' },
  { slug: 'notebook_lm', displayName: 'NotebookLM Enterprise', category: 'Analytics & Data', description: 'Enterprise notebooks and sources in a Google Cloud project' },
  // Google Workspace — additional Composio-managed OAuth services
  { slug: 'google_classroom', displayName: 'Google Classroom', category: 'Google Workspace', description: 'Classes, coursework, and student submissions' },
  { slug: 'googlephotos', displayName: 'Google Photos', category: 'Google Workspace', description: 'Photo albums and media management' },
  { slug: 'googlesuper', displayName: 'Google Super', category: 'Google Workspace', description: 'Multiple Google services through one connection' },
  // Maps & Location — additional Composio-managed OAuth services
  { slug: 'google_maps', displayName: 'Google Maps', category: 'Maps & Location', description: 'Location data, places, and directions' },
  // Recruiting — additional Composio-managed OAuth services
  { slug: 'greenhouse', displayName: 'Greenhouse', category: 'Recruiting', description: 'Recruiting, candidates, and job applications' },
  // E-commerce — additional Composio-managed OAuth services
  { slug: 'gumroad', displayName: 'Gumroad', category: 'E-commerce', description: 'Product sales, customers, and memberships' },
  { slug: 'shippo', displayName: 'Shippo', category: 'E-commerce', description: 'Shipping labels, packages, and tracking' },
  { slug: 'zoho_inventory', displayName: 'Zoho Inventory', category: 'E-commerce', description: 'Stock, orders, and inventory management' },
  // Design — additional Composio-managed OAuth services
  { slug: 'miro', displayName: 'Miro', category: 'Design', description: 'Collaborative whiteboards and visual planning' },
  { slug: 'mural', displayName: 'Mural', category: 'Design', description: 'Visual collaboration and digital whiteboards' },
  { slug: 'zeplin', displayName: 'Zeplin', category: 'Design', description: 'Design projects, screens, components, and assets' },
  // Field Services — additional Composio-managed OAuth services
  { slug: 'servicem8', displayName: 'ServiceM8', category: 'Field Services', description: 'Field service jobs, scheduling, quotes, and invoices' },
]
const services = process.env.COMPOSIO_PLATFORM_MODE === 'true'
  ? [...ALL_SERVICES, ...GAMUT_PLATFORM_ACCOUNTS]
  : ALL_SERVICES
// Older hosts omit this list. New hosts send the toolkit slugs supported by
// their selected account provider, including an empty list when none apply.
const availableToolkits = process.env.CONNECTED_ACCOUNT_TOOLKITS
const allowedToolkits = availableToolkits === undefined ? undefined : new Set(availableToolkits.split(','))
export const SERVICES: ServiceInfo[] = allowedToolkits === undefined
  ? services
  : services.filter((service) => allowedToolkits.has(service.slug))

export function isRequestableToolkit(slug: string): boolean {
  return SERVICES.some((s) => s.slug === slug)
}

export const searchConnectedAccountServicesTool = tool(
  'search_connected_account_services',
  `Search for available OAuth services that can be connected via the request_connected_account tool. Call with no search term to list all services, or provide a search term to filter by name, category, or description.`,
  {
    search: z
      .string()
      .optional()
      .describe(
        'Optional search term to filter services (matches name, slug, category, or description). Omit to list all.'
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
            text: args.search
              ? `No services found matching "${args.search}". Call with no search term to see all available services.`
              : 'No connected-account services are available on this host.',
          },
        ],
      }
    }

    const grouped: Record<string, ServiceInfo[]> = {}
    for (const s of results) {
      if (!grouped[s.category]) grouped[s.category] = []
      grouped[s.category].push(s)
    }

    const lines: string[] = [`Found ${results.length} service(s):\n`]
    for (const [category, services] of Object.entries(grouped)) {
      lines.push(`## ${category}`)
      for (const s of services) {
        lines.push(`- ${s.slug} (${s.displayName}) - ${s.description}`)
      }
      lines.push('')
    }
    lines.push(
      'Use request_connected_account with the slug to connect a service.'
    )

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    }
  }
)
