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
    slug: 'slack',
    displayName: 'Slack',
    icon: 'message-square',
    description: 'Team communication platform',
  },
  {
    slug: 'github',
    displayName: 'GitHub',
    icon: 'github',
    description: 'Code repository and collaboration',
  },
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
    slug: 'twitter',
    displayName: 'Twitter/X',
    icon: 'twitter',
    description: 'Social media platform',
  },
  {
    slug: 'discord',
    displayName: 'Discord',
    icon: 'message-circle',
    description: 'Community chat platform',
  },
  {
    slug: 'trello',
    displayName: 'Trello',
    icon: 'layout-grid',
    description: 'Project boards and task management',
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
