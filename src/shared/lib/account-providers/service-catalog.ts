import type { ProviderName } from './base-account-provider'

export interface Provider {
  slug: string
  displayName: string
  icon: string
  description: string
  composioSlug?: string
  nangoSlug?: string
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
]

const SLUG_KEY: Record<ProviderName, keyof Provider> = {
  composio: 'composioSlug',
  nango: 'nangoSlug',
}

export function getProvider(slug: string): Provider | undefined {
  return SUPPORTED_PROVIDERS.find((p) => p.slug === slug)
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
