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

const SERVICES: ServiceInfo[] = [
  // Google Workspace
  { slug: 'gmail', displayName: 'Gmail', category: 'Google Workspace', description: 'Google email service' },
  { slug: 'googlecalendar', displayName: 'Google Calendar', category: 'Google Workspace', description: 'Google calendar and scheduling' },
  { slug: 'googledrive', displayName: 'Google Drive', category: 'Google Workspace', description: 'Google cloud storage' },
  { slug: 'googlesheets', displayName: 'Google Sheets', category: 'Google Workspace', description: 'Google spreadsheets' },
  { slug: 'googledocs', displayName: 'Google Docs', category: 'Google Workspace', description: 'Google documents' },
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
  // Scheduling & Forms
  { slug: 'calendly', displayName: 'Calendly', category: 'Scheduling & Forms', description: 'Scheduling and appointments' },
  { slug: 'typeform', displayName: 'Typeform', category: 'Scheduling & Forms', description: 'Forms and surveys' },
]

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
            text: `No services found matching "${args.search}". Call with no search term to see all available services.`,
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
