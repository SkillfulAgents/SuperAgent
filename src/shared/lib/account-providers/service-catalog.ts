import type { ProviderName } from './base-account-provider'

export interface Provider {
  slug: string
  displayName: string
  icon: string
  description: string
  composioSlug?: string
  nangoSlug?: string
  /**
   * Exists only through Gamut's Composio (a custom auth config on Gamut's own
   * developer app), so it is hidden on a local Composio key.
   */
  platformOnly?: true
  /**
   * Not offered in the directory, the agent's service search, or the chat
   * card's Connect button. Arrivals and reconnects still work.
   */
  unlisted?: true
  /**
   * Connecting starts on this page (an app store listing), never from a Gamut
   * grant: its install hands the account back through `arrivalParam`.
   */
  installUrl?: string
  /** The account is named after what it is authorized for, so it cannot be renamed. */
  fixedName?: true
  /**
   * The search param an install hands the account's identity back in, on
   * /settings/connections. Connections connects it on arrival.
   */
  arrivalParam?: string
}

export const SUPPORTED_PROVIDERS: Provider[] = [
  // Google Workspace
  {
    slug: 'gmail',
    displayName: 'Gmail',
    icon: 'mail',
    description: 'Google email service',
    composioSlug: 'gmail',
    nangoSlug: 'google-mail',
  },
  {
    slug: 'googlecalendar',
    displayName: 'Google Calendar',
    icon: 'calendar',
    description: 'Google calendar and scheduling',
    composioSlug: 'googlecalendar',
    nangoSlug: 'google-calendar',
  },
  {
    slug: 'googledrive',
    displayName: 'Google Drive',
    icon: 'hard-drive',
    description: 'Google cloud storage',
    composioSlug: 'googledrive',
    nangoSlug: 'google-drive',
  },
  {
    slug: 'googlesheets',
    displayName: 'Google Sheets',
    icon: 'table',
    description: 'Google spreadsheets',
    composioSlug: 'googlesheets',
    nangoSlug: 'google-sheets',
  },
  {
    slug: 'googledocs',
    displayName: 'Google Docs',
    icon: 'file-text',
    description: 'Google documents',
    composioSlug: 'googledocs',
    nangoSlug: 'google-docs',
  },
  {
    slug: 'googleslides',
    displayName: 'Google Slides',
    icon: 'presentation',
    description: 'Google presentations',
    composioSlug: 'googleslides',
    nangoSlug: 'google-slides',
  },
  {
    slug: 'googlemeet',
    displayName: 'Google Meet',
    icon: 'video',
    description: 'Google video conferencing',
    composioSlug: 'googlemeet',
    nangoSlug: 'google-meet',
  },
  {
    slug: 'googletasks',
    displayName: 'Google Tasks',
    icon: 'check-square',
    description: 'Google task management',
    composioSlug: 'googletasks',
    nangoSlug: 'google-tasks',
  },
  {
    slug: 'youtube',
    displayName: 'YouTube',
    icon: 'play-circle',
    description: 'Video platform',
    composioSlug: 'youtube',
    nangoSlug: 'youtube',
  },

  // Microsoft
  {
    slug: 'outlook',
    displayName: 'Outlook',
    icon: 'mail',
    description: 'Microsoft email and calendar',
    composioSlug: 'outlook',
    nangoSlug: 'outlook',
  },
  {
    slug: 'microsoft_teams',
    displayName: 'Microsoft Teams',
    icon: 'message-square',
    description: 'Microsoft team communication',
    composioSlug: 'microsoft_teams',
    nangoSlug: 'microsoft-teams',
  },

  // Communication
  {
    slug: 'slack',
    displayName: 'Slack',
    icon: 'message-square',
    description: 'Team communication platform',
    composioSlug: 'slack',
    nangoSlug: 'slack',
  },
  {
    slug: 'discord',
    displayName: 'Discord',
    icon: 'message-circle',
    description: 'Community chat platform',
    composioSlug: 'discord',
    nangoSlug: 'discord',
  },

  // Developer Tools
  {
    slug: 'github',
    displayName: 'GitHub',
    icon: 'github',
    description: 'Code repository and collaboration',
    composioSlug: 'github',
    nangoSlug: 'github',
  },
  {
    slug: 'gitlab',
    displayName: 'GitLab',
    icon: 'git-branch',
    description: 'Code repository and CI/CD',
    composioSlug: 'gitlab',
    nangoSlug: 'gitlab',
  },
  {
    slug: 'bitbucket',
    displayName: 'Bitbucket',
    icon: 'git-branch',
    description: 'Code repository and pipelines',
    composioSlug: 'bitbucket',
    nangoSlug: 'bitbucket',
  },
  {
    slug: 'sentry',
    displayName: 'Sentry',
    icon: 'bug',
    description: 'Error tracking and monitoring',
    composioSlug: 'sentry',
    nangoSlug: 'sentry',
  },

  // Project Management
  {
    slug: 'notion',
    displayName: 'Notion',
    icon: 'file-text',
    description: 'Workspace and documentation',
    composioSlug: 'notion',
    nangoSlug: 'notion',
  },
  {
    slug: 'linear',
    displayName: 'Linear',
    icon: 'check-square',
    description: 'Issue tracking and project management',
    composioSlug: 'linear',
    nangoSlug: 'linear',
  },
  {
    slug: 'confluence',
    displayName: 'Confluence',
    icon: 'book-open',
    description: 'Team documentation and wiki',
    composioSlug: 'confluence',
    nangoSlug: 'confluence',
  },
  {
    slug: 'asana',
    displayName: 'Asana',
    icon: 'check-circle',
    description: 'Project and task management',
    composioSlug: 'asana',
    nangoSlug: 'asana',
  },
  {
    slug: 'monday',
    displayName: 'Monday.com',
    icon: 'layout-grid',
    description: 'Work management platform',
    composioSlug: 'monday',
    nangoSlug: 'monday',
  },
  {
    slug: 'clickup',
    displayName: 'ClickUp',
    icon: 'check-circle',
    description: 'Project management and productivity',
    composioSlug: 'clickup',
    nangoSlug: 'clickup',
  },
  {
    slug: 'trello',
    displayName: 'Trello',
    icon: 'layout-grid',
    description: 'Project boards and task management',
    composioSlug: 'trello',
    nangoSlug: 'trello',
  },

  // CRM & Sales
  {
    slug: 'hubspot',
    displayName: 'HubSpot',
    icon: 'users',
    description: 'CRM and marketing platform',
    composioSlug: 'hubspot',
    nangoSlug: 'hubspot',
  },
  {
    slug: 'salesforce',
    displayName: 'Salesforce',
    icon: 'cloud',
    description: 'CRM and sales platform',
    composioSlug: 'salesforce',
    nangoSlug: 'salesforce',
  },
  {
    slug: 'zendesk',
    displayName: 'Zendesk',
    icon: 'headphones',
    description: 'Customer support and ticketing',
    composioSlug: 'zendesk',
    nangoSlug: 'zendesk',
  },
  {
    slug: 'intercom',
    displayName: 'Intercom',
    icon: 'message-circle',
    description: 'Customer messaging platform',
    composioSlug: 'intercom',
    nangoSlug: 'intercom',
  },
  {
    slug: 'highlevel',
    displayName: 'HighLevel',
    icon: 'briefcase',
    description: 'CRM: contacts, conversations, calendars',
    composioSlug: 'highlevel',
    platformOnly: true,
  },

  // Cloud Storage & Documents
  {
    slug: 'airtable',
    displayName: 'Airtable',
    icon: 'table',
    description: 'Spreadsheet-database hybrid',
    composioSlug: 'airtable',
    nangoSlug: 'airtable',
  },
  {
    slug: 'dropbox',
    displayName: 'Dropbox',
    icon: 'hard-drive',
    description: 'Cloud file storage',
    composioSlug: 'dropbox',
    nangoSlug: 'dropbox',
  },
  {
    slug: 'box',
    displayName: 'Box',
    icon: 'box',
    description: 'Cloud content management',
    composioSlug: 'box',
    nangoSlug: 'box',
  },

  // Social Media
  {
    slug: 'linkedin',
    displayName: 'LinkedIn',
    icon: 'briefcase',
    description: 'Professional networking',
    composioSlug: 'linkedin',
    nangoSlug: 'linkedin',
  },
  {
    slug: 'instagram',
    displayName: 'Instagram',
    icon: 'camera',
    description: 'Photo and video sharing',
    composioSlug: 'instagram',
    nangoSlug: 'instagram',
  },
  {
    slug: 'twitter',
    displayName: 'X',
    icon: 'at-sign',
    description: 'Posts, timelines, and direct messages',
    composioSlug: 'twitter',
    platformOnly: true,
  },

  // E-commerce
  {
    slug: 'shopify',
    displayName: 'Shopify',
    icon: 'shopping-bag',
    description: 'Online store: products, orders, customers',
    composioSlug: 'shopify',
    platformOnly: true,
    // Shopify only allows installing Gamut's app from its App Store listing (rule 2.3.1).
    installUrl: 'https://apps.shopify.com/gamut',
    fixedName: true,
    arrivalParam: 'shop',
  },

  // Finance
  {
    slug: 'stripe',
    displayName: 'Stripe',
    icon: 'credit-card',
    description: 'Payment processing',
    composioSlug: 'stripe',
    nangoSlug: 'stripe',
  },
  {
    slug: 'quickbooks',
    displayName: 'QuickBooks',
    icon: 'calculator',
    description: 'Accounting and bookkeeping',
    composioSlug: 'quickbooks',
    nangoSlug: 'quickbooks',
  },
  {
    slug: 'xero',
    displayName: 'Xero',
    icon: 'calculator',
    description: 'Accounting software',
    composioSlug: 'xero',
    nangoSlug: 'xero',
  },
  {
    slug: 'plaid',
    displayName: 'Plaid',
    icon: 'landmark',
    description: 'Bank accounts, balances, and transactions',
    // Plaid Link is not OAuth: the platform's toolkit bridge hosts it as a custom toolkit.
    composioSlug: 'custom_plaid',
    platformOnly: true,
  },

  // Marketing
  {
    slug: 'mailchimp',
    displayName: 'Mailchimp',
    icon: 'mail',
    description: 'Email marketing platform',
    composioSlug: 'mailchimp',
    nangoSlug: 'mailchimp',
  },

  // Design
  {
    slug: 'figma',
    displayName: 'Figma',
    icon: 'pen-tool',
    description: 'Collaborative design tool',
    composioSlug: 'figma',
    nangoSlug: 'figma',
  },
  {
    slug: 'canva',
    displayName: 'Canva',
    icon: 'pen-tool',
    description: 'Designs, exports, and brand templates',
    composioSlug: 'canva',
  },

  // Scheduling & Forms
  {
    slug: 'calendly',
    displayName: 'Calendly',
    icon: 'calendar',
    description: 'Scheduling and appointments',
    composioSlug: 'calendly',
    nangoSlug: 'calendly',
  },
  {
    slug: 'typeform',
    displayName: 'Typeform',
    icon: 'file-text',
    description: 'Forms and surveys',
    composioSlug: 'typeform',
    nangoSlug: 'typeform',
  },

  // Video
  {
    slug: 'zoom',
    displayName: 'Zoom',
    icon: 'video',
    description: 'Video conferencing',
    composioSlug: 'zoom',
    nangoSlug: 'zoom',
  },

  // Communication — additional Composio-managed OAuth services
  {
    slug: 'aircall',
    displayName: 'Aircall',
    icon: 'phone',
    description: 'Business calls, contacts, teams, and phone numbers',
    composioSlug: 'aircall',
  },
  {
    slug: 'dialpad',
    displayName: 'Dialpad',
    icon: 'phone',
    description: 'Business phone, messaging, and contact center',
    composioSlug: 'dialpad',
  },
  {
    slug: 'discordbot',
    displayName: 'Discord Bot',
    icon: 'message-circle',
    description: 'Discord server access through a bot',
    composioSlug: 'discordbot',
  },
  {
    slug: 'fathom',
    displayName: 'Fathom',
    icon: 'video',
    description: 'Meeting recordings, transcripts, and summaries',
    composioSlug: 'fathom',
  },
  {
    slug: 'roam',
    displayName: 'Roam',
    icon: 'message-square',
    description: 'Roam HQ messaging, files, and collaboration',
    composioSlug: 'roam',
  },
  {
    slug: 'slackbot',
    displayName: 'Slack Bot',
    icon: 'message-square',
    description: 'Workspace search and history with messaging as a Slack bot',
    composioSlug: 'slackbot',
  },
  {
    slug: 'webex',
    displayName: 'Webex',
    icon: 'video',
    description: 'Meetings, messaging, and team collaboration',
    composioSlug: 'webex',
  },
  {
    slug: 'whatsapp',
    displayName: 'WhatsApp Business',
    icon: 'message-circle',
    description: 'Customer messaging through the WhatsApp Business API',
    composioSlug: 'whatsapp',
  },
  {
    slug: 'zoho_mail',
    displayName: 'Zoho Mail',
    icon: 'mail',
    description: 'Business email and mailbox management',
    composioSlug: 'zoho_mail',
  },

  // Hospitality — additional Composio-managed OAuth services
  {
    slug: 'apaleo',
    displayName: 'Apaleo',
    icon: 'building',
    description: 'Property management, reservations, and billing',
    composioSlug: 'apaleo',
  },

  // CRM & Sales — additional Composio-managed OAuth services
  {
    slug: 'attio',
    displayName: 'Attio',
    icon: 'users',
    description: 'Customer records, relationship data, tasks, and comments',
    composioSlug: 'attio',
  },
  {
    slug: 'blackbaud',
    displayName: 'Blackbaud',
    icon: 'heart',
    description: 'Nonprofit fundraising and donor management',
    composioSlug: 'blackbaud',
  },
  {
    slug: 'capsule_crm',
    displayName: 'Capsule CRM',
    icon: 'users',
    description: 'Customer relationships, sales pipelines, and tasks',
    composioSlug: 'capsule_crm',
  },
  {
    slug: 'dynamics365',
    displayName: 'Microsoft Dynamics 365',
    icon: 'users',
    description: 'Business customer records and operations',
    composioSlug: 'dynamics365',
  },
  {
    slug: 'gong',
    displayName: 'Gong',
    icon: 'phone',
    description: 'Sales calls, transcripts, and revenue intelligence',
    composioSlug: 'gong',
  },
  {
    slug: 'gorgias',
    displayName: 'Gorgias',
    icon: 'headphones',
    description: 'E-commerce support tickets and customer conversations',
    composioSlug: 'gorgias',
  },
  {
    slug: 'zoho',
    displayName: 'Zoho CRM',
    icon: 'users',
    description: 'Customer records, sales pipelines, and CRM workflows',
    composioSlug: 'zoho',
  },
  {
    slug: 'zoho_bigin',
    displayName: 'Zoho Bigin',
    icon: 'users',
    description: 'Small business sales pipelines and contacts',
    composioSlug: 'zoho_bigin',
  },
  {
    slug: 'zoho_desk',
    displayName: 'Zoho Desk',
    icon: 'headphones',
    description: 'Support tickets and customer service',
    composioSlug: 'zoho_desk',
  },

  // Project Management — additional Composio-managed OAuth services
  {
    slug: 'basecamp',
    displayName: 'Basecamp',
    icon: 'check-square',
    description: 'Projects, tasks, and team collaboration',
    composioSlug: 'basecamp',
  },
  {
    slug: 'dart',
    displayName: 'Dart',
    icon: 'check-square',
    description: 'Projects, tasks, and team planning',
    composioSlug: 'dart',
  },
  {
    slug: 'jira',
    displayName: 'Jira',
    icon: 'check-square',
    description: 'Issues, projects, and agile planning',
    composioSlug: 'jira',
  },
  {
    slug: 'productboard',
    displayName: 'Productboard',
    icon: 'layout-grid',
    description: 'Customer feedback, features, and product roadmaps',
    composioSlug: 'productboard',
  },
  {
    slug: 'wrike',
    displayName: 'Wrike',
    icon: 'check-square',
    description: 'Projects, tasks, and team workflows',
    composioSlug: 'wrike',
  },

  // Cloud Storage & Documents — additional Composio-managed OAuth services
  {
    slug: 'boldsign',
    displayName: 'BoldSign',
    icon: 'pen-tool',
    description: 'Electronic signatures and document signing',
    composioSlug: 'boldsign',
  },

  // Scheduling & Forms — additional Composio-managed OAuth services
  {
    slug: 'cal',
    displayName: 'Cal.com',
    icon: 'calendar',
    description: 'Booking pages, availability, and scheduling',
    composioSlug: 'cal',
  },

  // Content & Marketing — additional Composio-managed OAuth services
  {
    slug: 'contentful',
    displayName: 'Contentful',
    icon: 'file-text',
    description: 'Content management and publishing',
    composioSlug: 'contentful',
  },
  {
    slug: 'crowdin',
    displayName: 'Crowdin',
    icon: 'languages',
    description: 'Translation and localization management',
    composioSlug: 'crowdin',
  },
  {
    slug: 'dub',
    displayName: 'Dub',
    icon: 'link',
    description: 'Branded short links and link analytics',
    composioSlug: 'dub',
  },
  {
    slug: 'googleads',
    displayName: 'Google Ads',
    icon: 'megaphone',
    description: 'Advertising campaigns and performance reporting',
    composioSlug: 'googleads',
  },
  {
    slug: 'kit',
    displayName: 'Kit',
    icon: 'mail',
    description: 'Creator email marketing and subscriber management',
    composioSlug: 'kit',
  },
  {
    slug: 'omnisend',
    displayName: 'Omnisend',
    icon: 'mail',
    description: 'E-commerce email and SMS marketing',
    composioSlug: 'omnisend',
  },
  {
    slug: 'pinterest_ads',
    displayName: 'Pinterest Ads',
    icon: 'megaphone',
    description: 'Pinterest advertising campaigns and reporting',
    composioSlug: 'pinterest_ads',
  },
  {
    slug: 'reddit_ads',
    displayName: 'Reddit Ads',
    icon: 'megaphone',
    description: 'Reddit advertising campaigns and account data',
    composioSlug: 'reddit_ads',
  },
  {
    slug: 'tiktok_ads',
    displayName: 'TikTok Ads',
    icon: 'megaphone',
    description: 'Business advertising campaigns, creatives, and reports',
    composioSlug: 'tiktok_ads',
  },

  // Developer Tools — additional Composio-managed OAuth services
  {
    slug: 'daytona',
    displayName: 'Daytona',
    icon: 'terminal',
    description: 'Daytona account profile',
    composioSlug: 'daytona',
  },
  {
    slug: 'hugging_face',
    displayName: 'Hugging Face',
    icon: 'cpu',
    description: 'Hugging Face account profile',
    composioSlug: 'hugging_face',
  },
  {
    slug: 'pagerduty',
    displayName: 'PagerDuty',
    icon: 'bell',
    description: 'Incident response and on-call operations',
    composioSlug: 'pagerduty',
  },
  {
    slug: 'prisma',
    displayName: 'Prisma',
    icon: 'database',
    description: 'Data Platform projects, environments, and database services',
    composioSlug: 'prisma',
  },
  {
    slug: 'stack_exchange',
    displayName: 'Stack Exchange',
    icon: 'message-circle',
    description: 'Questions, answers, and communities',
    composioSlug: 'stack_exchange',
  },
  {
    slug: 'supabase',
    displayName: 'Supabase',
    icon: 'database',
    description: 'Supabase projects and Management API operations',
    composioSlug: 'supabase',
  },
  {
    slug: 'wakatime',
    displayName: 'WakaTime',
    icon: 'clock',
    description: 'Coding activity, projects, and time tracking',
    composioSlug: 'wakatime',
  },

  // Events & Ticketing — additional Composio-managed OAuth services
  {
    slug: 'eventbrite',
    displayName: 'Eventbrite',
    icon: 'ticket',
    description: 'Events, tickets, and attendee management',
    composioSlug: 'eventbrite',
  },
  {
    slug: 'ticketmaster',
    displayName: 'Ticketmaster',
    icon: 'ticket',
    description: 'Event discovery and ticketing',
    composioSlug: 'ticketmaster',
  },

  // Microsoft — additional Composio-managed OAuth services
  {
    slug: 'excel',
    displayName: 'Microsoft Excel',
    icon: 'table',
    description: 'Workbooks in OneDrive for Business and SharePoint',
    composioSlug: 'excel',
  },
  {
    slug: 'one_drive',
    displayName: 'OneDrive',
    icon: 'hard-drive',
    description: 'Microsoft cloud files and folders',
    composioSlug: 'one_drive',
  },
  {
    slug: 'share_point',
    displayName: 'SharePoint',
    icon: 'files',
    description: 'Team sites, documents, and lists',
    composioSlug: 'share_point',
  },

  // Personal Productivity — additional Composio-managed OAuth services
  {
    slug: 'exist',
    displayName: 'Exist',
    icon: 'bar-chart',
    description: 'Personal activity tracking and analytics',
    composioSlug: 'exist',
  },
  {
    slug: 'harvest',
    displayName: 'Harvest',
    icon: 'clock',
    description: 'Time tracking, projects, and invoicing',
    composioSlug: 'harvest',
  },
  {
    slug: 'linkhut',
    displayName: 'Linkhut',
    icon: 'bookmark',
    description: 'Bookmarks and shared links',
    composioSlug: 'linkhut',
  },
  {
    slug: 'pushbullet',
    displayName: 'Pushbullet',
    icon: 'bell',
    description: 'Notifications, links, and files across devices',
    composioSlug: 'pushbullet',
  },
  {
    slug: 'ticktick',
    displayName: 'TickTick',
    icon: 'check-square',
    description: 'Tasks, projects, and to-do lists',
    composioSlug: 'ticktick',
  },
  {
    slug: 'timely',
    displayName: 'Timely',
    icon: 'clock',
    description: 'Time tracking, projects, and timesheets',
    composioSlug: 'timely',
  },
  {
    slug: 'todoist',
    displayName: 'Todoist',
    icon: 'check-square',
    description: 'Tasks, projects, and reminders',
    composioSlug: 'todoist',
  },
  {
    slug: 'yandex',
    displayName: 'Yandex',
    icon: 'search',
    description: 'Yandex account profile',
    composioSlug: 'yandex',
  },

  // Social Media — additional Composio-managed OAuth services
  {
    slug: 'facebook',
    displayName: 'Facebook Pages',
    icon: 'message-circle',
    description: 'Facebook Pages, posts, and audience engagement',
    composioSlug: 'facebook',
  },
  {
    slug: 'pinterest',
    displayName: 'Pinterest',
    icon: 'image',
    description: 'Pins, boards, and visual discovery',
    composioSlug: 'pinterest',
  },
  {
    slug: 'reddit',
    displayName: 'Reddit',
    icon: 'message-circle',
    description: 'Communities, posts, and discussions',
    composioSlug: 'reddit',
  },
  {
    slug: 'twitch',
    displayName: 'Twitch',
    icon: 'video',
    description: 'Live streams, channels, and communities',
    composioSlug: 'twitch',
  },

  // Finance — additional Composio-managed OAuth services
  {
    slug: 'freeagent',
    displayName: 'FreeAgent',
    icon: 'calculator',
    description: 'Small business accounting, invoices, and expenses',
    composioSlug: 'freeagent',
  },
  {
    slug: 'freshbooks',
    displayName: 'FreshBooks',
    icon: 'calculator',
    description: 'Invoices, expenses, and time tracking',
    composioSlug: 'freshbooks',
  },
  {
    slug: 'moneybird',
    displayName: 'Moneybird',
    icon: 'calculator',
    description: 'Invoices, expenses, and small business accounting',
    composioSlug: 'moneybird',
  },
  {
    slug: 'splitwise',
    displayName: 'Splitwise',
    icon: 'receipt',
    description: 'Shared expenses, groups, and balances',
    composioSlug: 'splitwise',
  },
  {
    slug: 'square',
    displayName: 'Square',
    icon: 'credit-card',
    description: 'Payments, orders, customers, and inventory',
    composioSlug: 'square',
  },
  {
    slug: 'ynab',
    displayName: 'YNAB',
    icon: 'calculator',
    description: 'Budgets, accounts, and spending',
    composioSlug: 'ynab',
  },
  {
    slug: 'zoho_books',
    displayName: 'Zoho Books',
    icon: 'calculator',
    description: 'Accounting, invoices, and expenses',
    composioSlug: 'zoho_books',
  },
  {
    slug: 'zoho_invoice',
    displayName: 'Zoho Invoice',
    icon: 'receipt',
    description: 'Invoices, recurring billing, and expenses',
    composioSlug: 'zoho_invoice',
  },

  // Analytics & Data — additional Composio-managed OAuth services
  {
    slug: 'google_analytics',
    displayName: 'Google Analytics',
    icon: 'bar-chart',
    description: 'Website and app traffic reports',
    composioSlug: 'google_analytics',
  },
  {
    slug: 'googlebigquery',
    displayName: 'Google BigQuery',
    icon: 'database',
    description: 'Cloud data warehouse and SQL queries',
    composioSlug: 'googlebigquery',
  },
  {
    slug: 'google_search_console',
    displayName: 'Google Search Console',
    icon: 'search',
    description: 'Search performance, sitemaps, and URL inspection',
    composioSlug: 'google_search_console',
  },
  {
    slug: 'notebook_lm',
    displayName: 'NotebookLM Enterprise',
    icon: 'book-open',
    description: 'Enterprise notebooks and sources in a Google Cloud project',
    composioSlug: 'notebook_lm',
  },

  // Google Workspace — additional Composio-managed OAuth services
  {
    slug: 'google_classroom',
    displayName: 'Google Classroom',
    icon: 'graduation-cap',
    description: 'Classes, coursework, and student submissions',
    composioSlug: 'google_classroom',
  },
  {
    slug: 'googlephotos',
    displayName: 'Google Photos',
    icon: 'image',
    description: 'Photo albums and media management',
    composioSlug: 'googlephotos',
  },
  {
    slug: 'googlesuper',
    displayName: 'Google Super',
    icon: 'cloud',
    description: 'Multiple Google services through one connection',
    composioSlug: 'googlesuper',
  },

  // Maps & Location — additional Composio-managed OAuth services
  {
    slug: 'google_maps',
    displayName: 'Google Maps',
    icon: 'map',
    description: 'Location data, places, and directions',
    composioSlug: 'google_maps',
  },

  // Recruiting — additional Composio-managed OAuth services
  {
    slug: 'greenhouse',
    displayName: 'Greenhouse',
    icon: 'users',
    description: 'Recruiting, candidates, and job applications',
    composioSlug: 'greenhouse',
  },

  // E-commerce — additional Composio-managed OAuth services
  {
    slug: 'gumroad',
    displayName: 'Gumroad',
    icon: 'shopping-bag',
    description: 'Product sales, customers, and memberships',
    composioSlug: 'gumroad',
  },
  {
    slug: 'shippo',
    displayName: 'Shippo',
    icon: 'package',
    description: 'Shipping labels, packages, and tracking',
    composioSlug: 'shippo',
  },
  {
    slug: 'zoho_inventory',
    displayName: 'Zoho Inventory',
    icon: 'package',
    description: 'Stock, orders, and inventory management',
    composioSlug: 'zoho_inventory',
  },

  // Design — additional Composio-managed OAuth services
  {
    slug: 'miro',
    displayName: 'Miro',
    icon: 'layout-grid',
    description: 'Collaborative whiteboards and visual planning',
    composioSlug: 'miro',
  },
  {
    slug: 'mural',
    displayName: 'Mural',
    icon: 'layout-grid',
    description: 'Visual collaboration and digital whiteboards',
    composioSlug: 'mural',
  },
  {
    slug: 'zeplin',
    displayName: 'Zeplin',
    icon: 'pen-tool',
    description: 'Design projects, screens, components, and assets',
    composioSlug: 'zeplin',
  },

  // Field Services — additional Composio-managed OAuth services
  {
    slug: 'servicem8',
    displayName: 'ServiceM8',
    icon: 'wrench',
    description: 'Field service jobs, scheduling, quotes, and invoices',
    composioSlug: 'servicem8',
  },
]

const SLUG_KEY: Record<ProviderName, keyof Provider> = {
  composio: 'composioSlug',
  nango: 'nangoSlug',
}

export function getProvider(slug: string): Provider | undefined {
  return SUPPORTED_PROVIDERS.find((p) => p.slug === slug)
}

/** The provider's display name, or its slug capitalized when the catalog does not list it. */
export function getProviderDisplayName(slug: string): string {
  return getProvider(slug)?.displayName ?? `${slug.charAt(0).toUpperCase()}${slug.slice(1)}`
}

export function getAllProviders(providerName?: ProviderName): Provider[] {
  if (!providerName) return SUPPORTED_PROVIDERS
  const key = SLUG_KEY[providerName]
  return SUPPORTED_PROVIDERS.filter((p) => p[key] != null)
}

export function isProviderSupported(slug: string, providerName?: ProviderName): boolean {
  const entry = SUPPORTED_PROVIDERS.find((p) => p.slug === slug)
  if (!entry) return false
  if (!providerName) return true
  return entry[SLUG_KEY[providerName]] != null
}

export function getProviderSlug(slug: string, providerName: ProviderName): string {
  const entry = getProvider(slug)
  if (!entry) return slug
  return (entry[SLUG_KEY[providerName]] as string | undefined) ?? slug
}

export function getToolkitSlugFromProviderSlug(providerSlug: string, providerName: ProviderName): string | undefined {
  const key = SLUG_KEY[providerName]
  const entry = SUPPORTED_PROVIDERS.find((p) => p[key] === providerSlug)
  return entry?.slug
}
