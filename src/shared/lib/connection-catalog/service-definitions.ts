/**
 * Services whose ways in the catalogs cannot line up on their own, and the
 * services that say which way to use.
 *
 * Everything else groups itself: an account, a remote MCP server and an agent
 * integration with the same slug are one service. A definition lists its
 * members of each kind exactly, and a member it lists appears only in the
 * services that list it, so one integration can serve several services (the
 * meeting bot joins Zoom, Google Meet and Teams calls).
 *
 * `guidance` is for what the catalogs cannot say themselves: when one way
 * beats another for this service. The generic rules (an account or an MCP acts
 * as the user, an integration as the agent) live in the search tool's
 * description, not here.
 */
export interface ServiceDefinition {
  service: string
  displayName: string
  /** Shown under the heading and searched, for a service its members do not describe. */
  description?: string
  /** Connected-account toolkit slugs (`SUPPORTED_PROVIDERS`). */
  accounts?: readonly string[]
  /** Remote MCP catalog slugs (`COMMON_MCP_SERVERS`). */
  mcps?: readonly string[]
  /** Agent integration providers (`agentIntegrationRegistry`). */
  integrations?: readonly string[]
  guidance?: string
}

const MAILBOX_GUIDANCE = 'The user\'s own mailbox → the account. Mail from the agent\'s own address, with replies arriving as sessions → the Email integration.'

const MEETING_GUIDANCE = 'To attend a call (speak when addressed, answer in the call chat, take notes), use join_meeting: it sends the agent\'s own meeting bot and needs no setup. The account works with the user\'s data on the service through its API, as the user.'

export const SERVICE_DEFINITIONS: readonly ServiceDefinition[] = [
  {
    service: 'slack',
    displayName: 'Slack',
    accounts: ['slack', 'slackbot'],
    integrations: ['slack'],
    guidance: 'Talking with people as the agent (they DM or mention it, it answers as itself) → the integration. Acting as the user (their DMs, search, posts under their name) → the `slack` account. `slackbot` reads workspace history and messages as a bot through the API, without the integration\'s chat sessions.',
  },
  {
    service: 'linear',
    displayName: 'Linear',
    accounts: ['linear'],
    mcps: ['linear'],
    integrations: ['linear'],
    guidance: 'The integration is the agent\'s own Linear app: people assign issues to it or mention it, and it works under its own name. Use it when the work should come from the agent; use the MCP or the account when it should come from the user.',
  },
  {
    service: 'github',
    displayName: 'GitHub',
    accounts: ['github'],
    mcps: ['github'],
    integrations: ['github'],
    guidance: 'The integration is the agent\'s own GitHub App: mentioning it in an issue or pull request starts work, and its comments and commits come from its bot. Use it when the agent should act as itself; use the MCP or the account to act as the user.',
  },
  {
    service: 'figma',
    displayName: 'Figma',
    accounts: ['figma'],
    mcps: ['figma'],
    guidance: 'Prefer the MCP: it is more capable than the REST API behind the account, for reading designs and generating code from frames. Use the account only where you need the API itself, such as from a script.',
  },
  {
    service: 'notion',
    displayName: 'Notion',
    accounts: ['notion'],
    mcps: ['notion'],
    guidance: 'Prefer the MCP: it is more capable than the REST API behind the account, for searching the workspace and reading and editing pages. Use the account only where you need the API itself, such as from a script.',
  },
  {
    service: 'gmail',
    displayName: 'Gmail',
    accounts: ['gmail'],
    integrations: ['platform-email'],
    guidance: MAILBOX_GUIDANCE,
  },
  {
    service: 'outlook',
    displayName: 'Outlook',
    accounts: ['outlook'],
    integrations: ['platform-email'],
    guidance: MAILBOX_GUIDANCE,
  },
  {
    service: 'email',
    displayName: 'Email',
    description: 'The agent\'s own inbox',
    integrations: ['platform-email'],
    guidance: 'For the user\'s own mailbox, connect Gmail or Outlook instead.',
  },
  {
    service: 'zoom',
    displayName: 'Zoom',
    accounts: ['zoom'],
    integrations: ['recall'],
    guidance: MEETING_GUIDANCE,
  },
  {
    service: 'googlemeet',
    displayName: 'Google Meet',
    accounts: ['googlemeet'],
    integrations: ['recall'],
    guidance: MEETING_GUIDANCE,
  },
  {
    service: 'microsoft_teams',
    displayName: 'Microsoft Teams',
    accounts: ['microsoft_teams'],
    integrations: ['recall'],
    guidance: MEETING_GUIDANCE,
  },
  {
    service: 'meetings',
    displayName: 'Meetings',
    description: 'Attend Zoom, Google Meet and Microsoft Teams calls as the agent',
    integrations: ['recall'],
  },
  {
    service: 'plaid',
    displayName: 'Plaid',
    accounts: ['plaid'],
    mcps: ['plaid'],
    guidance: 'The account reads the user\'s bank accounts, balances and transactions. The MCP reports on a Plaid developer integration (Link analytics, usage).',
  },
  // Same service, slugs that differ between the catalogs.
  { service: 'atlassian', displayName: 'Atlassian (Jira, Confluence)', accounts: ['jira', 'confluence'], mcps: ['atlassian'] },
  { service: 'discord', displayName: 'Discord', accounts: ['discord', 'discordbot'] },
  { service: 'cal', displayName: 'Cal.com', accounts: ['cal'], mcps: ['cal-com'] },
  { service: 'hugging_face', displayName: 'Hugging Face', accounts: ['hugging_face'], mcps: ['huggingface'] },
  { service: 'tiktok_ads', displayName: 'TikTok Ads', accounts: ['tiktok_ads'], mcps: ['tiktok-ads', 'tiktok-ads-progressive'] },
]
