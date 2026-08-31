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
  googleslides: ['slides.googleapis.com', 'www.googleapis.com'],
  googlemeet: ['meet.googleapis.com', 'www.googleapis.com'],
  googletasks: ['tasks.googleapis.com', 'www.googleapis.com'],
  youtube: ['www.googleapis.com', 'youtube.googleapis.com'],

  // Microsoft
  outlook: ['graph.microsoft.com'],
  microsoft_teams: ['graph.microsoft.com'],

  // Communication
  // slack.com hosts the Web API (slack.com/api/...); files.slack.com serves
  // private file downloads (url_private / url_private_download).
  slack: ['slack.com', 'files.slack.com'],
  discord: ['discord.com'],

  // Developer Tools
  // api.github.com serves the REST API only. github.com carries the git
  // smart-HTTP transport and every non-API endpoint, raw.githubusercontent.com
  // serves file contents, and uploads.github.com is the separate host the
  // create-release API hands back as `upload_url`. Download hosts (codeload,
  // release assets) are reached by redirect, which is followed server-side, so
  // they need no entry — and naming them directly would inject an Authorization
  // header onto an already-signed URL.
  github: [
    'api.github.com',
    'github.com',
    'raw.githubusercontent.com',
    'uploads.github.com',
  ],
  gitlab: ['gitlab.com'],
  // bitbucket.org carries the git transport; api.bitbucket.org is REST only.
  bitbucket: ['api.bitbucket.org', 'bitbucket.org'],
  // Sentry's API host is region-specific (us.sentry.io, de.sentry.io).
  sentry: ['sentry.io', '*.sentry.io'],
  // Datadog has one API host per site; a customer is on exactly one of them.
  datadog: [
    'api.datadoghq.com',
    'api.datadoghq.eu',
    'api.us3.datadoghq.com',
    'api.us5.datadoghq.com',
    'api.ap1.datadoghq.com',
    'api.ap2.datadoghq.com',
    'api.ddog-gov.com',
  ],
  // events.pagerduty.com is the Events API v2 host, separate from the REST API.
  pagerduty: ['api.pagerduty.com', 'events.pagerduty.com'],

  // Project Management
  notion: ['api.notion.com'],
  // uploads.linear.app receives the file uploads the API issues URLs for.
  linear: ['api.linear.app', 'uploads.linear.app'],
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
  // content.airtable.com hosts uploadAttachment, which api.airtable.com does not.
  airtable: ['api.airtable.com', 'content.airtable.com'],
  dropbox: ['api.dropboxapi.com', 'content.dropboxapi.com'],
  box: ['api.box.com', 'upload.box.com'],
  docusign: ['*.docusign.net', '*.docusign.com'],

  // Social Media
  // upload.twitter.com serves the v1.1 media upload endpoints.
  twitter: ['api.twitter.com', 'api.x.com', 'upload.twitter.com'],
  linkedin: ['api.linkedin.com'],
  instagram: ['graph.instagram.com', 'graph.facebook.com'],

  // E-Commerce & Finance
  shopify: ['*.myshopify.com'],
  // files.stripe.com is the file create/upload host.
  stripe: ['api.stripe.com', 'files.stripe.com'],
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

/**
 * Generic host-vs-patterns matcher. A pattern is either an exact host or a
 * `*.suffix` wildcard that matches any real subdomain (but not the bare domain
 * or a suffix-spoof). Shared by the toolkit allowlist and the web allowed-sites
 * filter so the two cannot drift.
 */
export function matchesHostPatterns(host: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1) // e.g. '.atlassian.net'
      return host.endsWith(suffix) && host.length > suffix.length
    }
    return pattern === host
  })
}

export function isHostAllowed(toolkit: string, host: string): boolean {
  const allowed = TOOLKIT_ALLOWED_HOSTS[toolkit]
  if (!allowed) return false
  return matchesHostPatterns(host, allowed)
}
