/** The Slack app a directory reads people and sends DMs with: what it asks for, whoever creates it. */

export const SLACK_DIRECTORY_SCOPES = ['users:read', 'users:read.email'] as const
/** Optional: DMing people their invitations and mentions. */
export const SLACK_NOTIFY_SCOPES = ['chat:write', 'im:write'] as const

/**
 * The directory's app: created by Gamut from an app configuration token, or
 * by an admin through Slack's prefilled manifest link. It has no events, so it
 * needs no webhook URL.
 */
export function slackDirectoryAppManifest() {
  return {
    display_information: {
      name: 'Gamut',
      description: 'Lets Gamut find your teammates so you can invite them.',
    },
    features: { bot_user: { display_name: 'Gamut', always_online: false } },
    oauth_config: { scopes: { bot: [...SLACK_DIRECTORY_SCOPES, ...SLACK_NOTIFY_SCOPES] } },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  }
}
