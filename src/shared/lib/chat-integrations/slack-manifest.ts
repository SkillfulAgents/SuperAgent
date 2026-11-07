/**
 * The Slack app a Slack integration expects, as an app manifest. Socket Mode
 * without a webhook URL; Event Subscriptions and Interactivity posting to the
 * installation's relay endpoint with one.
 */

export const BOT_SCOPES = [
  'users:read',
  'chat:write',
  'files:read',
  'files:write',
  'im:history',
  'im:read',
  'im:write',
  'channels:history',
  'channels:read',
  'groups:history',
  'groups:read',
  'mpim:history',
  'mpim:read',
  'reactions:write',
  'reactions:read',
  'emoji:read',
  'pins:read',
  'pins:write',
  'bookmarks:read',
  'bookmarks:write',
  'canvases:read',
  'canvases:write',
  'lists:read',
  'lists:write',
  'channels:join',
  'channels:manage',
  'groups:write',
  'usergroups:read',
]

export const SLACK_BOT_EVENTS = ['message.im', 'message.channels', 'message.groups', 'message.mpim']

/** The manifest's `settings`: what moves between Socket Mode and webhooks. */
export function slackManifestSettings(webhookUrl?: string) {
  return {
    event_subscriptions: {
      ...(webhookUrl ? { request_url: webhookUrl } : {}),
      bot_events: SLACK_BOT_EVENTS,
    },
    interactivity: { is_enabled: true, ...(webhookUrl ? { request_url: webhookUrl } : {}) },
    org_deploy_enabled: false,
    socket_mode_enabled: !webhookUrl,
    token_rotation_enabled: false,
  }
}

/**
 * What the Slack app shows of its agent. A manifest can't carry an icon: that
 * is uploaded in the app's Basic Information.
 */
export interface SlackAppIdentity {
  name: string
  description?: string
  /** Hex, behind the app's name on its hovercard. */
  backgroundColor?: string
}

/** Slack refuses a short description over 140 characters: whole words, then an ellipsis. */
function shortDescription(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= 140) return flat
  const cut = flat.slice(0, 139)
  const space = cut.lastIndexOf(' ')
  return `${space > 0 ? cut.slice(0, space) : cut}…`
}

export function slackAppManifest(app: SlackAppIdentity, webhookUrl?: string) {
  const description = app.description && shortDescription(app.description)
  return {
    display_information: {
      // Slack refuses a manifest whose app name is over 35 characters.
      name: app.name.slice(0, 35),
      ...(description ? { description } : {}),
      ...(app.backgroundColor ? { background_color: app.backgroundColor } : {}),
    },
    features: {
      // The bot user's name is separate from the app's in Slack: renaming one leaves the other.
      bot_user: { display_name: app.name.slice(0, 80), always_online: true },
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
    },
    oauth_config: { scopes: { bot: BOT_SCOPES } },
    settings: slackManifestSettings(webhookUrl),
  }
}

/** Opens Slack's "Create an app" flow with the manifest filled in. */
export function slackAppCreationUrl(app: SlackAppIdentity, webhookUrl?: string): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackAppManifest(app, webhookUrl)))}`
}
