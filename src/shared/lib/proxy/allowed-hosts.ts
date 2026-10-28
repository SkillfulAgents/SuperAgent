// Regional API hosts are explicit: connection fields must never authorize an
// arbitrary host. Zoho's Canada Mail/Desk hosts use zohocloud.ca.
// https://www.zoho.com/mail/help/api/getting-started-with-api.html
// https://desk.zoho.com/DeskAPIDocument
const ZOHO_API_HOSTS = [
  'www.zohoapis.com', 'www.zohoapis.eu', 'www.zohoapis.in',
  'www.zohoapis.com.au', 'www.zohoapis.com.cn', 'www.zohoapis.jp',
  'www.zohoapis.ca', 'www.zohoapis.sa', 'www.zohoapis.ae',
]

// https://learn.microsoft.com/en-us/power-platform/admin/new-datacenter-regions
const DYNAMICS365_API_HOSTS = [
  ...['crm', 'crm2', 'crm3', 'crm4', 'crm5', 'crm6', 'crm7', 'crm8',
    'crm9', 'crm11', 'crm12', 'crm14', 'crm15', 'crm16', 'crm17',
    'crm19', 'crm20', 'crm21', 'crm22'].map((region) => `*.api.${region}.dynamics.com`),
  '*.api.crm.dynamics.cn',
  '*.api.crm.microsoftdynamics.de',
  '*.api.crm.microsoftdynamics.us',
  'globaldisco.crm.dynamics.com',
]

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
  // OAuth 3LO uses api.atlassian.com/ex/jira/{cloudId}; site APIs serve other auth modes.
  jira: ['*.atlassian.net', 'api.atlassian.com'],
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
  highlevel: ['services.leadconnectorhq.com'],

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
  // Agents address Plaid's own hosts; the platform proxy routes them via its toolkit bridge.
  plaid: ['production.plaid.com', 'development.plaid.com', 'sandbox.plaid.com'],
  quickbooks: [
    'quickbooks.api.intuit.com',
    'sandbox-quickbooks.api.intuit.com',
  ],
  xero: ['api.xero.com'],

  // Marketing
  mailchimp: ['*.api.mailchimp.com'],

  // Design
  figma: ['api.figma.com'],
  canva: ['api.canva.com'],

  // Scheduling & Forms
  calendly: ['api.calendly.com'],
  typeform: ['api.typeform.com'],

  // Video
  zoom: ['api.zoom.us'],

  // Communication (sales)
  // OAuth returns a customer-specific api_base_url_for_customer.
  gong: ['api.gong.io', '*.api.gong.io'],

  // Additional Composio-managed OAuth toolkits, verified against toolkit metadata
  // on 2026-10-21. Keep service API hosts narrow; OAuth does not grant general
  // access to every host owned by the vendor.
  aircall: ['api.aircall.io'],
  apaleo: ['api.apaleo.com'],
  attio: ['api.attio.com'],
  basecamp: ['3.basecampapi.com', 'launchpad.37signals.com'],
  blackbaud: ['api.sky.blackbaud.com'],
  boldsign: [
    'api.boldsign.com',
    'api-eu.boldsign.com',
    'api-ca.boldsign.com',
    'api-au.boldsign.com',
  ],
  cal: ['api.cal.com'],
  capsule_crm: ['api.capsulecrm.com'],
  contentful: ['api.contentful.com'],
  crowdin: ['api.crowdin.com'],
  dart: ['app.itsdart.com', 'app.dartai.com'],
  daytona: ['app.daytona.io'],
  dialpad: ['dialpad.com'],
  discordbot: ['discord.com'],
  dub: ['api.dub.co'],
  dynamics365: DYNAMICS365_API_HOSTS,
  eventbrite: ['www.eventbriteapi.com'],
  excel: ['graph.microsoft.com'],
  exist: ['exist.io'],
  facebook: ['graph.facebook.com'],
  fathom: ['fathom.video'],
  freeagent: ['api.freeagent.com'],
  freshbooks: ['api.freshbooks.com'],
  google_analytics: ['analyticsdata.googleapis.com', 'analyticsadmin.googleapis.com', 'www.googleapis.com'],
  google_classroom: ['classroom.googleapis.com'],
  google_maps: ['maps.googleapis.com', 'places.googleapis.com', 'routes.googleapis.com'],
  google_search_console: ['www.googleapis.com', 'searchconsole.googleapis.com'],
  googleads: ['googleads.googleapis.com'],
  googlebigquery: ['bigquery.googleapis.com', 'www.googleapis.com'],
  googlephotos: ['photoslibrary.googleapis.com'],
  googlesuper: [
    'www.googleapis.com',
    'gmail.googleapis.com',
    'sheets.googleapis.com',
    'docs.googleapis.com',
    'slides.googleapis.com',
    'tasks.googleapis.com',
    'people.googleapis.com',
    'googleads.googleapis.com',
    'analyticsdata.googleapis.com',
    'analyticsadmin.googleapis.com',
    'photoslibrary.googleapis.com',
  ],
  gorgias: ['*.gorgias.com'],
  greenhouse: ['harvest.greenhouse.io'],
  gumroad: ['api.gumroad.com'],
  harvest: ['api.harvestapp.com'],
  hugging_face: ['huggingface.co'],
  kit: ['api.kit.com'],
  linkhut: ['api.ln.ht'],
  miro: ['api.miro.com'],
  moneybird: ['moneybird.com'],
  mural: ['app.mural.co'],
  notebook_lm: ['discoveryengine.googleapis.com'],
  omnisend: ['api.omnisend.com'],
  one_drive: ['graph.microsoft.com'],
  pinterest: ['api.pinterest.com'],
  pinterest_ads: ['api.pinterest.com'],
  prisma: ['api.prisma.io'],
  productboard: ['api.productboard.com'],
  pushbullet: ['api.pushbullet.com'],
  reddit: ['oauth.reddit.com'],
  reddit_ads: ['ads-api.reddit.com', 'oauth.reddit.com'],
  roam: ['api.ro.am'],
  servicem8: ['api.servicem8.com'],
  share_point: ['*.sharepoint.com'],
  shippo: ['api.goshippo.com'],
  slackbot: ['slack.com', 'files.slack.com'],
  splitwise: ['secure.splitwise.com'],
  square: ['connect.squareup.com'],
  stack_exchange: ['api.stackexchange.com'],
  supabase: ['api.supabase.com'],
  ticketmaster: ['app.ticketmaster.com'],
  ticktick: ['api.ticktick.com'],
  tiktok_ads: ['business-api.tiktok.com'],
  timely: ['api.timelyapp.com'],
  todoist: ['api.todoist.com'],
  twitch: ['api.twitch.tv', 'id.twitch.tv'],
  wakatime: ['api.wakatime.com', 'wakatime.com'],
  webex: ['webexapis.com'],
  whatsapp: ['graph.facebook.com'],
  wrike: ['www.wrike.com', 'app-eu.wrike.com', 'app-us2.wrike.com'],
  yandex: ['oauth.yandex.com', 'login.yandex.ru'],
  ynab: ['api.ynab.com'],
  zeplin: ['api.zeplin.dev'],
  zoho: ZOHO_API_HOSTS,
  zoho_bigin: ZOHO_API_HOSTS,
  zoho_books: ZOHO_API_HOSTS,
  zoho_desk: [
    'desk.zoho.com',
    'desk.zoho.eu',
    'desk.zoho.in',
    'desk.zoho.com.au',
    'desk.zoho.com.cn',
    'desk.zoho.jp',
    'desk.zohocloud.ca',
    'desk.zoho.sa',
    'desk.zoho.ae',
    'desk.zoho.sg',
  ],
  zoho_inventory: ZOHO_API_HOSTS,
  zoho_invoice: ZOHO_API_HOSTS,
  zoho_mail: [
    'mail.zoho.com',
    'mail.zoho.eu',
    'mail.zoho.in',
    'mail.zoho.com.au',
    'mail.zoho.com.cn',
    'mail.zoho.jp',
    'mail.zohocloud.ca',
    'mail.zoho.sa',
    'mail.zoho.ae',
  ],
}

/**
 * Generic host-vs-patterns matcher. A pattern is either an exact host or a
 * `*.suffix` wildcard that matches any real subdomain (but not the bare domain
 * or a suffix-spoof). Shared by the toolkit allowlist and the web allowed-sites
 * filter so the two cannot drift. It does no validation of its own: `host` must
 * already be a hostname the URL parser produced or accepted unchanged. Rejecting
 * odd hosts here would let them slip past the web filter's block list.
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

// Dot-separated labels of ASCII letters, digits and hyphens: no userinfo, port,
// brackets, percent-escapes, whitespace, `#`, `?`, `\`, or trailing dot. Without
// the `u` flag, `i` never folds a non-ASCII character onto an ASCII letter.
const BARE_HOSTNAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/i

/**
 * The lowercase hostname `https://<host>/` names, when that is exactly `host`
 * up to case; otherwise null. Callers match the host string against the
 * allowlist and then request `https://<host>/<path>`, so a string the URL
 * parser would read as some other host must not pass.
 */
function bareHostname(host: string): string | null {
  if (!BARE_HOSTNAME.test(host)) return null
  const lower = host.toLowerCase()
  try {
    return new URL(`https://${host}/`).hostname === lower ? lower : null
  } catch {
    return null
  }
}

/**
 * Whether the toolkit may be called at `host`. Only a bare hostname qualifies
 * (in any case, as DNS ignores it), so the host checked here is the host a
 * request to `https://<host>/…` reaches.
 */
export function isHostAllowed(toolkit: string, host: string): boolean {
  const allowed = TOOLKIT_ALLOWED_HOSTS[toolkit]
  if (!allowed) return false
  const hostname = bareHostname(host)
  return hostname !== null && matchesHostPatterns(hostname, allowed)
}
