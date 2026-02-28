// Per-toolkit allowlist of target hosts.
// The proxy rejects requests to hosts not in this list for the account's toolkit.
// Entries starting with '*.' are wildcard patterns matching any subdomain.
export const TOOLKIT_ALLOWED_HOSTS: Record<string, string[]> = {
  // Google Workspace
  gmail: ['gmail.googleapis.com', 'www.googleapis.com'],
  googlecalendar: ['www.googleapis.com'],
  googledrive: ['www.googleapis.com'],
  googlesheets: ['sheets.googleapis.com', 'www.googleapis.com'],
  googledocs: ['docs.googleapis.com', 'www.googleapis.com'],
  googlemeet: ['meet.googleapis.com', 'www.googleapis.com'],
  googletasks: ['tasks.googleapis.com', 'www.googleapis.com'],
  youtube: ['www.googleapis.com', 'youtube.googleapis.com'],

  // Microsoft
  outlook: ['graph.microsoft.com'],
  microsoftteams: ['graph.microsoft.com'],

  // Communication
  slack: ['slack.com'],
  discord: ['discord.com'],

  // Developer Tools
  github: ['api.github.com'],
  gitlab: ['gitlab.com'],
  bitbucket: ['api.bitbucket.org'],
  sentry: ['sentry.io'],
  datadog: ['api.datadoghq.com', 'api.us5.datadoghq.com'],
  pagerduty: ['api.pagerduty.com'],

  // Project Management
  notion: ['api.notion.com'],
  linear: ['api.linear.app'],
  jira: ['*.atlassian.net'],
  confluence: ['*.atlassian.net'],
  asana: ['app.asana.com', 'api.asana.com'],
  monday: ['api.monday.com'],
  clickup: ['api.clickup.com'],
  trello: ['api.trello.com'],

  // CRM & Sales
  hubspot: ['api.hubapi.com'],
  salesforce: ['*.my.salesforce.com', '*.salesforce.com'],
  pipedrive: ['api.pipedrive.com'],
  zendesk: ['*.zendesk.com'],
  intercom: ['api.intercom.io'],

  // Cloud Storage & Documents
  airtable: ['api.airtable.com'],
  dropbox: ['api.dropboxapi.com', 'content.dropboxapi.com'],
  box: ['api.box.com', 'upload.box.com'],
  docusign: ['*.docusign.net', '*.docusign.com'],

  // Social Media
  twitter: ['api.twitter.com', 'api.x.com'],
  linkedin: ['api.linkedin.com'],
  instagram: ['graph.instagram.com', 'graph.facebook.com'],

  // E-Commerce & Finance
  shopify: ['*.myshopify.com'],
  stripe: ['api.stripe.com'],
  quickbooks: [
    'quickbooks.api.intuit.com',
    'sandbox-quickbooks.api.intuit.com',
  ],
  xero: ['api.xero.com'],

  // Marketing
  mailchimp: ['*.api.mailchimp.com'],

  // Design
  figma: ['api.figma.com'],

  // Scheduling & Forms
  calendly: ['api.calendly.com'],
  typeform: ['api.typeform.com'],

  // Video
  zoom: ['api.zoom.us'],

  // Communication (sales)
  gong: ['api.gong.io'],
}

export function isHostAllowed(toolkit: string, host: string): boolean {
  const allowed = TOOLKIT_ALLOWED_HOSTS[toolkit]
  if (!allowed) return false
  return allowed.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1) // e.g. '.atlassian.net'
      return host.endsWith(suffix) && host.length > suffix.length
    }
    return pattern === host
  })
}
