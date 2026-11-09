/**
 * A Slack workspace as a team directory, read with a bot token that has
 * `users:read` and `users:read.email`. Gamut usually makes that app itself,
 * from an app configuration token (slack-provisioning.ts); an admin can still
 * paste a bot token from an app they made.
 */
import { z } from 'zod'
import { DirectoryConnectError, type DirectoryMessage, type DirectoryUser, type TeamDirectoryProvider } from '../types'
import { SlackApiError, slackCall } from './slack-api'
import { SLACK_DIRECTORY_SCOPES, SLACK_NOTIFY_SCOPES, slackDirectoryAppManifest } from './slack-directory-app'
import { slackAppProvisioning } from './slack-provisioning'

export { SLACK_DIRECTORY_SCOPES, SLACK_NOTIFY_SCOPES, slackDirectoryAppManifest }

const PAGE_SIZE = 200
/** Far past the workspaces this is for (tens to hundreds); a bigger one is listed this far. */
const MAX_USERS = 5_000

export const slackDirectoryCredentialsSchema = z.object({
  botToken: z.string().trim().regex(/^xoxb-/, 'Paste the bot token: it starts with xoxb-'),
})
export type SlackDirectoryCredentials = z.infer<typeof slackDirectoryCredentialsSchema>

const authTestSchema = z.object({
  team: z.string().optional(),
  team_id: z.string(),
  enterprise_id: z.string().optional(),
})

const memberSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  real_name: z.string().optional(),
  deleted: z.boolean().optional(),
  is_bot: z.boolean().optional(),
  is_app_user: z.boolean().optional(),
  is_restricted: z.boolean().optional(),
  is_ultra_restricted: z.boolean().optional(),
  is_invited_user: z.boolean().optional(),
  is_email_confirmed: z.boolean().optional(),
  profile: z.object({
    real_name: z.string().optional(),
    display_name: z.string().optional(),
    email: z.string().optional(),
    image_192: z.string().optional(),
    image_72: z.string().optional(),
  }).optional(),
})
type SlackMember = z.infer<typeof memberSchema>

const conversationOpenSchema = z.object({ channel: z.object({ id: z.string() }) })

const usersListSchema = z.object({
  members: z.array(memberSchema).optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
})

/** People only: bots, app users, Slackbot, guests, people invited to Slack but not in yet, and deactivated accounts are left out. */
export function isSlackPerson(member: SlackMember): boolean {
  return !member.deleted
    && !member.is_bot
    && !member.is_app_user
    && member.id !== 'USLACKBOT'
    && !member.is_restricted
    && !member.is_ultra_restricted
    && !member.is_invited_user
}

export function toDirectoryUser(member: SlackMember, tenantId: string): DirectoryUser {
  const email = member.profile?.email?.trim()
  const avatarUrl = member.profile?.image_192 || member.profile?.image_72
  return {
    provider: 'slack',
    tenantId,
    remoteId: member.id,
    name: member.profile?.real_name || member.real_name || member.profile?.display_name || member.name || member.id,
    ...(email ? { email } : {}),
    // Slack confirms a member's email before they can join; the flag says whether it has.
    emailVerified: !!email && member.is_email_confirmed === true,
    ...(avatarUrl ? { avatarUrl } : {}),
  }
}

async function listSlackUsers(token: string, tenantId: string): Promise<DirectoryUser[]> {
  const users: DirectoryUser[] = []
  let cursor: string | undefined
  do {
    const { body } = await slackCall('users.list', token, { limit: PAGE_SIZE, cursor }, usersListSchema)
    for (const member of body.members ?? []) {
      if (isSlackPerson(member)) users.push(toDirectoryUser(member, tenantId))
    }
    cursor = body.response_metadata?.next_cursor || undefined
  } while (cursor && users.length < MAX_USERS)
  return users.slice(0, MAX_USERS)
}

/** Slack mrkdwn treats these three as control characters in any text it shows. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function slackMessageText(message: DirectoryMessage): string {
  const lines = [escapeSlack(message.headline)]
  if (message.quote) lines.push(...message.quote.split('\n').map((line) => `>${escapeSlack(line)}`))
  lines.push(`<${message.link.url.replace(/[|>]/g, encodeURIComponent)}|${escapeSlack(message.link.label)}>`)
  return lines.join('\n')
}

function describeSlackError(error: unknown): string {
  if (!(error instanceof SlackApiError)) return 'Slack could not be reached. Check the connection and try again.'
  switch (error.code) {
    case 'invalid_auth':
    case 'not_authed':
    case 'token_revoked':
    case 'account_inactive':
      return 'Slack does not accept this token. Copy the Bot User OAuth Token again from the app’s OAuth & Permissions page.'
    case 'missing_scope':
      return error.method === 'users.list' || error.method === 'auth.test'
        ? `The token is missing a scope. Add ${SLACK_DIRECTORY_SCOPES.join(' and ')} under OAuth & Permissions, reinstall the app, and paste the new token.`
        : `The token can’t send DMs. Add ${SLACK_NOTIFY_SCOPES.join(' and ')} under OAuth & Permissions, reinstall the app, and paste the new token.`
    case 'ratelimited':
      return 'Slack is rate limiting this app. Try again in a minute.'
    default:
      return `Slack answered ${error.code}.`
  }
}

export const slackDirectoryProvider: TeamDirectoryProvider<SlackDirectoryCredentials> = {
  provisioning: slackAppProvisioning,
  info: {
    id: 'slack',
    label: 'Slack',
    description: 'Find people in your Slack workspace when you share an agent or mention someone.',
    fields: [{ key: 'botToken', label: 'Bot User OAuth Token', placeholder: 'xoxb-…', secret: true }],
    steps: [
      'Create the Slack app from the prefilled manifest, or add the users:read and users:read.email bot scopes to an app you already have (and chat:write and im:write, to send invitations by DM).',
      'Install the app to your workspace.',
      'Copy the Bot User OAuth Token from OAuth & Permissions and paste it below.',
    ],
    setupLink: {
      label: 'Create the Slack app',
      href: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackDirectoryAppManifest()))}`,
    },
  },
  credentialsSchema: slackDirectoryCredentialsSchema,

  async verify({ botToken }) {
    let tenant: { tenantId: string; tenantName: string }
    let scopes: string[] | null
    try {
      const { body, headers } = await slackCall('auth.test', botToken, {}, authTestSchema)
      tenant = { tenantId: body.enterprise_id || body.team_id, tenantName: body.team || body.team_id }
      const header = headers.get('x-oauth-scopes')
      scopes = header === null ? null : header.split(',').map((scope) => scope.trim())
    } catch (error) {
      throw new DirectoryConnectError(describeSlackError(error))
    }
    const granted = scopes
    const missing = granted && SLACK_DIRECTORY_SCOPES.filter((scope) => !granted.includes(scope))
    if (missing?.length) {
      throw new DirectoryConnectError(`The token is missing ${missing.join(' and ')}. Add it under OAuth & Permissions, reinstall the app, and paste the new token.`)
    }
    if (!scopes) {
      // No scope header to read: ask for one page instead, which needs the same scopes.
      try {
        await slackCall('users.list', botToken, { limit: 1 }, usersListSchema)
      } catch (error) {
        throw new DirectoryConnectError(describeSlackError(error))
      }
    }
    const unsent = granted && SLACK_NOTIFY_SCOPES.filter((scope) => !granted.includes(scope))
    return {
      ...tenant,
      ...(unsent?.length ? { notices: [`Invitations won’t be sent by Slack DM: the token is missing ${unsent.join(' and ')}.`] } : {}),
    }
  },

  open({ tenantId, credentials }) {
    return {
      async listUsers() {
        try {
          return await listSlackUsers(credentials.botToken, tenantId)
        } catch (error) {
          throw new DirectoryConnectError(describeSlackError(error))
        }
      },
      async notifyUser(user, message) {
        try {
          const { body } = await slackCall('conversations.open', credentials.botToken, { users: user.remoteId }, conversationOpenSchema)
          await slackCall('chat.postMessage', credentials.botToken, {
            channel: body.channel.id,
            text: slackMessageText(message),
            unfurl_links: 'false',
          }, z.object({}))
        } catch (error) {
          throw new DirectoryConnectError(describeSlackError(error))
        }
      },
    }
  },
}
