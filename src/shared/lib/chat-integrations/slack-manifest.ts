/**
 * The Slack app a Slack integration expects, as an app manifest. Socket Mode
 * without a webhook URL; Event Subscriptions and Interactivity posting to the
 * installation's relay endpoint with one.
 */

const BOT_SCOPES = [
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

export function slackAppManifest(botName: string, webhookUrl?: string) {
  return {
    // Slack refuses a manifest whose app name is over 35 characters.
    display_information: { name: botName.slice(0, 35) },
    features: {
      bot_user: { display_name: botName.slice(0, 80), always_online: true },
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
export function slackAppCreationUrl(botName: string, webhookUrl?: string): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackAppManifest(botName, webhookUrl)))}`
}
