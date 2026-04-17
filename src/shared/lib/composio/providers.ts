/**
 * Supported OAuth providers for Composio integration.
 * This is the master list of providers that users can connect.
 * Auth configs will be auto-created in Composio using managed OAuth.
 */

export interface Provider {
  slug: string // Composio toolkit slug (e.g., 'gmail', 'slack')
  displayName: string // Human-friendly name (e.g., 'Gmail', 'Slack')
  icon: string // Lucide icon name
  description: string // Brief description of the service
}

export const SUPPORTED_PROVIDERS: Provider[] = [
  // Google Workspace
  {
    slug: 'gmail',
    displayName: 'Gmail',
    icon: 'mail',
    description: 'Google email service',
  },
  {
    slug: 'googlecalendar',
    displayName: 'Google Calendar',
    icon: 'calendar',
    description: 'Google calendar and scheduling',
  },
  {
    slug: 'googledrive',
    displayName: 'Google Drive',
    icon: 'hard-drive',
    description: 'Google cloud storage',
  },
  {
    slug: 'googlesheets',
    displayName: 'Google Sheets',
    icon: 'table',
    description: 'Google spreadsheets',
  },
  {
    slug: 'googledocs',
    displayName: 'Google Docs',
    icon: 'file-text',
    description: 'Google documents',
  },
  {
    slug: 'googlemeet',
    displayName: 'Google Meet',
    icon: 'video',
    description: 'Google video conferencing',
  },
  {
    slug: 'googletasks',
    displayName: 'Google Tasks',
    icon: 'check-square',
    description: 'Google task management',
  },
  {
    slug: 'youtube',
    displayName: 'YouTube',
    icon: 'play-circle',
    description: 'Video platform',
  },

  // Microsoft
  {
    slug: 'outlook',
    displayName: 'Outlook',
    icon: 'mail',
    description: 'Microsoft email and calendar',
  },
  {
    slug: 'microsoft_teams',
    displayName: 'Microsoft Teams',
    icon: 'message-square',
    description: 'Microsoft team communication',
  },

  // Communication
  {
    slug: 'slack',
    displayName: 'Slack',
    icon: 'message-square',
    description: 'Team communication platform',
  },
  {
    slug: 'discord',
    displayName: 'Discord',
    icon: 'message-circle',
    description: 'Community chat platform',
  },

  // Developer Tools
  {
    slug: 'github',
    displayName: 'GitHub',
    icon: 'github',
    description: 'Code repository and collaboration',
  },
  {
    slug: 'gitlab',
    displayName: 'GitLab',
    icon: 'git-branch',
    description: 'Code repository and CI/CD',
  },
  {
    slug: 'bitbucket',
    displayName: 'Bitbucket',
    icon: 'git-branch',
    description: 'Code repository and pipelines',
  },
  {
    slug: 'sentry',
    displayName: 'Sentry',
    icon: 'bug',
    description: 'Error tracking and monitoring',
  },

  // Project Management
  {
    slug: 'notion',
    displayName: 'Notion',
    icon: 'file-text',
    description: 'Workspace and documentation',
  },
  {
    slug: 'linear',
    displayName: 'Linear',
    icon: 'check-square',
    description: 'Issue tracking and project management',
  },
  {
    slug: 'asana',
    displayName: 'Asana',
    icon: 'check-circle',
    description: 'Project and task management',
  },
  {
    slug: 'clickup',
    displayName: 'ClickUp',
    icon: 'check-circle',
    description: 'Project management and productivity',
  },
  // CRM & Sales
  {
    slug: 'hubspot',
    displayName: 'HubSpot',
    icon: 'users',
    description: 'CRM and marketing platform',
  },
  {
    slug: 'salesforce',
    displayName: 'Salesforce',
    icon: 'cloud',
    description: 'CRM and sales platform',
  },
  {
    slug: 'intercom',
    displayName: 'Intercom',
    icon: 'message-circle',
    description: 'Customer messaging platform',
  },

  // Cloud Storage & Documents
  {
    slug: 'airtable',
    displayName: 'Airtable',
    icon: 'table',
    description: 'Spreadsheet-database hybrid',
  },
  {
    slug: 'dropbox',
    displayName: 'Dropbox',
    icon: 'hard-drive',
    description: 'Cloud file storage',
  },
  {
    slug: 'box',
    displayName: 'Box',
    icon: 'box',
    description: 'Cloud content management',
  },

  // Social Media
  {
    slug: 'linkedin',
    displayName: 'LinkedIn',
    icon: 'briefcase',
    description: 'Professional networking',
  },
  {
    slug: 'instagram',
    displayName: 'Instagram',
    icon: 'camera',
    description: 'Photo and video sharing',
  },

  // Finance
  {
    slug: 'stripe',
    displayName: 'Stripe',
    icon: 'credit-card',
    description: 'Payment processing',
  },
  {
    slug: 'quickbooks',
    displayName: 'QuickBooks',
    icon: 'calculator',
    description: 'Accounting and bookkeeping',
  },
  // Marketing
  {
    slug: 'mailchimp',
    displayName: 'Mailchimp',
    icon: 'mail',
    description: 'Email marketing platform',
  },

  // Design
  {
    slug: 'figma',
    displayName: 'Figma',
    icon: 'pen-tool',
    description: 'Collaborative design tool',
  },

  // Scheduling & Forms
  {
    slug: 'calendly',
    displayName: 'Calendly',
    icon: 'calendar',
    description: 'Scheduling and appointments',
  },
  {
    slug: 'typeform',
    displayName: 'Typeform',
    icon: 'file-text',
    description: 'Forms and surveys',
  },

  // Video
  {
    slug: 'zoom',
    displayName: 'Zoom',
    icon: 'video',
    description: 'Video conferencing',
  },

]

/**
 * Get a provider by its slug.
 */
export function getProvider(slug: string): Provider | undefined {
  return SUPPORTED_PROVIDERS.find((p) => p.slug === slug)
}

/**
 * Get all supported providers.
 */
export function getAllProviders(): Provider[] {
  return SUPPORTED_PROVIDERS
}

/**
 * Check if a provider slug is supported.
 */
export function isProviderSupported(slug: string): boolean {
  return SUPPORTED_PROVIDERS.some((p) => p.slug === slug)
}
