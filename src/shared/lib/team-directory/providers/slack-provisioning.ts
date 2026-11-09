/**
 * Creating Slack apps through Slack's App Manifest API, with an app
 * configuration token an admin pastes once: the directory's own app when the
 * directory is connected with the token, then each agent's.
 *
 * - The token belongs to the admin who generated it, lasts 12 hours, and is
 *   renewed with its refresh token (`tooling.tokens.rotate`), which hands back
 *   a new pair and retires the old refresh token. The host rotates it ahead of
 *   expiry (team-directory/provisioning.ts).
 * - An app is created with its manifest (`apps.manifest.create`): the agent's
 *   name, description and colour, its webhook URL for events and interactivity,
 *   and the host's OAuth callback. Its icon goes up separately (`apps.icon.set`).
 * - Installing it is one click by a person, on Slack's own page; the code that
 *   comes back is exchanged for the bot token (`oauth.v2.access`). Installing
 *   without a person needs Slack's partner-only `managed_apps:install`.
 * - The Manifest API is marked beta by Slack.
 */
import { z } from 'zod'
import { slackAppManifest } from '@shared/lib/chat-integrations/slack-manifest'
import { slackVerificationProfile } from '@shared/lib/chat-integrations/slack-verification'
import { slackDirectoryAppManifest } from './slack-directory-app'
import {
  DirectoryConnectError,
  ProvisioningCredentialsError,
  type AgentIdentityProvisioner,
  type AgentIdentityProvisioning,
} from '../types'
import { SlackApiError, slackCall } from './slack-api'

/** Rotate when less than this is left; the background pass runs every 6 hours, against a 12-hour token. */
const ROTATE_WITHIN_MS = 60 * 60_000

/**
 * An admin pastes only the refresh token: rotating it gives the access token.
 * What is stored always has both, from that first rotation on.
 */
export const slackConfigTokenSchema = z.object({
  accessToken: z.string().regex(/^xoxe\./).optional(),
  refreshToken: z.string().trim()
    .refine((token) => !token.startsWith('xoxe.'), 'That’s the access token. Paste the refresh token, the one that starts with xoxe-')
    .refine((token) => token.startsWith('xoxe-'), 'Paste the refresh token: it starts with xoxe-'),
  /** Epoch ms; unknown until the first rotation. */
  expiresAt: z.number().optional(),
  /** The workspace and the admin the token belongs to. */
  teamId: z.string().optional(),
  userId: z.string().optional(),
})
export type SlackConfigToken = z.infer<typeof slackConfigTokenSchema>

const rotatedSchema = z.object({
  token: z.string(),
  refresh_token: z.string(),
  exp: z.number(),
  team_id: z.string().optional(),
  user_id: z.string().optional(),
})

const manifestCreatedSchema = z.object({
  app_id: z.string(),
  credentials: z.object({ client_id: z.string(), client_secret: z.string(), signing_secret: z.string() }),
  oauth_authorize_url: z.string().url(),
})

const installedSchema = z.object({ access_token: z.string().regex(/^xoxb-/) })
const exportedSchema = z.object({ manifest: z.record(z.string(), z.unknown()) })

/** What the integration's config keeps of a created app. */
export const slackProvisionedAppSchema = z.object({
  appId: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
})

/** Breaks that rotating again can't mend. */
const BROKEN_CHAIN = new Set(['invalid_refresh_token', 'invalid_auth', 'token_revoked', 'account_inactive', 'not_authed'])

async function rotate(credentials: SlackConfigToken): Promise<SlackConfigToken> {
  try {
    const { body } = await slackCall('tooling.tokens.rotate', null, { refresh_token: credentials.refreshToken }, rotatedSchema)
    return {
      accessToken: body.token,
      refreshToken: body.refresh_token,
      expiresAt: body.exp * 1000,
      teamId: body.team_id ?? credentials.teamId,
      userId: body.user_id ?? credentials.userId,
    }
  } catch (error) {
    if (error instanceof SlackApiError && BROKEN_CHAIN.has(error.code)) {
      throw new ProvisioningCredentialsError(`Slack no longer renews the app configuration token (${error.code}). Generate a new one and add it again.`)
    }
    throw error
  }
}

/** The PNG as a multipart file. */
function iconForm(appId: string, icon: Uint8Array): FormData {
  const form = new FormData()
  form.set('app_id', appId)
  form.set('file', new Blob([Buffer.from(icon)], { type: 'image/png' }), 'icon.png')
  return form
}

/** `apps.manifest.create` with the host's OAuth callback added to the manifest. */
async function createFromManifest(token: string, manifest: { oauth_config: Record<string, unknown> }, redirectUrl: string) {
  const { body } = await slackCall('apps.manifest.create', token, {
    manifest: JSON.stringify({ ...manifest, oauth_config: { ...manifest.oauth_config, redirect_urls: [redirectUrl] } }),
  }, manifestCreatedSchema)
  return {
    body,
    app: slackProvisionedAppSchema.parse({ appId: body.app_id, clientId: body.credentials.client_id, clientSecret: body.credentials.client_secret }),
  }
}

function accessTokenOf(credentials: SlackConfigToken): string {
  // Never stored without one: verify rotates before anything is saved.
  if (!credentials.accessToken) throw new ProvisioningCredentialsError('The app configuration token was saved without its access token. Add it again.')
  return credentials.accessToken
}

function provisioner(credentials: SlackConfigToken): AgentIdentityProvisioner {
  const token = accessTokenOf(credentials)
  const setIcon = async (appId: string, icon: Uint8Array): Promise<boolean> => {
    try {
      await slackCall('apps.icon.set', token, iconForm(appId, icon), z.object({}))
      return true
    } catch (error) {
      console.warn(`[TeamDirectory] Setting the icon of Slack app ${appId} failed:`, error instanceof Error ? error.message : error)
      return false
    }
  }
  return {
    async createApp({ name, description, backgroundColor, icon, webhookUrl, redirectUrl }) {
      const { body, app } = await createFromManifest(token, slackAppManifest({ name, description, backgroundColor }, webhookUrl), redirectUrl)
      return {
        app,
        config: { signingSecret: body.credentials.signing_secret },
        installUrl: body.oauth_authorize_url,
        verification: slackVerificationProfile(body.credentials.signing_secret),
        iconSet: icon ? await setIcon(app.appId, icon) : false,
        settingsUrl: `https://api.slack.com/apps/${app.appId}`,
      }
    },

    async completeInstall(record, code, redirectUrl) {
      const app = slackProvisionedAppSchema.parse(record)
      const { body } = await slackCall('oauth.v2.access', null, {
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code,
        redirect_uri: redirectUrl,
      }, installedSchema)
      return { botToken: body.access_token }
    },

    async deleteApp(record) {
      const app = slackProvisionedAppSchema.parse(record)
      await slackCall('apps.manifest.delete', token, { app_id: app.appId }, z.object({}))
    },

    async updateApp(record, { name, icon }) {
      const app = slackProvisionedAppSchema.parse(record)
      if (name?.trim()) {
        // Only the names change: everything else in the app stays as it is now.
        const { body } = await slackCall('apps.manifest.export', token, { app_id: app.appId }, exportedSchema)
        const current = body.manifest as { display_information?: Record<string, unknown>; features?: { bot_user?: Record<string, unknown> } & Record<string, unknown> }
        const named = slackAppManifest({ name: name.trim() }, undefined)
        const manifest = {
          ...current,
          display_information: { ...current.display_information, name: named.display_information.name },
          features: { ...current.features, bot_user: { ...current.features?.bot_user, display_name: named.features.bot_user.display_name } },
        }
        await slackCall('apps.manifest.update', token, { app_id: app.appId, manifest: JSON.stringify(manifest) }, z.object({}))
      }
      return icon ? { iconSet: await setIcon(app.appId, icon) } : {}
    },
  }
}

export const slackAppProvisioning: AgentIdentityProvisioning<SlackConfigToken> = {
  integrationProvider: 'slack',
  info: {
    description: 'Create each agent its own Slack app, with its name, @handle and avatar, in one click.',
    fields: [{ key: 'refreshToken', label: 'Refresh token', placeholder: 'xoxe-1-…', secret: true }],
    steps: [
      'Open Your Apps in Slack. Under Your App Configuration Tokens, click Generate Token and pick your workspace. Use an account that will stay: the apps Gamut makes belong to it.',
      'Copy the refresh token (it starts with xoxe-) and paste it below. Gamut renews it from then on.',
    ],
    setupLink: { label: 'Open Your Apps', href: 'https://api.slack.com/apps' },
  },
  credentialsSchema: slackConfigTokenSchema,

  async verify(credentials, tenant) {
    // Rotating checks the token, gives its access token and says when that expires. The pasted refresh token retires with it.
    let rotated: SlackConfigToken
    try {
      rotated = await rotate(credentials)
    } catch (error) {
      if (error instanceof ProvisioningCredentialsError) throw new DirectoryConnectError('Slack does not accept this refresh token. Generate a new token and paste its refresh token.')
      throw new DirectoryConnectError(`Slack could not check the token${error instanceof SlackApiError ? ` (${error.code})` : ''}. Try again.`)
    }
    // Apps go to the token's workspace, which must be the directory's. A grid directory spans its workspaces.
    if (tenant?.tenantId.startsWith('T') && rotated.teamId && rotated.teamId !== tenant.tenantId) {
      throw new DirectoryConnectError('This token is for another Slack workspace than the directory’s.')
    }
    return rotated
  },
  needsRotation: (credentials, now) => credentials.expiresAt === undefined || credentials.expiresAt - now < ROTATE_WITHIN_MS,
  rotate,
  open: provisioner,

  async createDirectoryApp(credentials, { redirectUrl }) {
    try {
      const { body, app } = await createFromManifest(accessTokenOf(credentials), slackDirectoryAppManifest(), redirectUrl)
      // Installing it gives the directory's bot token (`completeInstall`).
      return { app, installUrl: body.oauth_authorize_url }
    } catch (error) {
      if (!(error instanceof SlackApiError)) throw error
      throw new DirectoryConnectError(`Slack did not create the app (${error.code}). Generate a new token and try again.`)
    }
  },
}
