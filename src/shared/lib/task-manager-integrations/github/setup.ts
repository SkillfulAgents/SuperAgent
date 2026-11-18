import { createHash, randomUUID } from 'node:crypto'
import { IntegrationSetupError, type IntegrationProviderSetup } from '../../agent-integrations/setup-types'
import { githubAuthorizationInputSchema, githubConfigSchema, githubSetupInputSchema, type GitHubConfig } from './config-schema'
import { githubAccountSchema, githubInstallationSchema, githubInstallCallbackSchema, githubManifestResultSchema } from './api-schema'
import { githubAppJwt, githubRequest } from './client'
import { readGitHubIntegration, updateGitHubConfig } from './store'

const hash = (state: string) => createHash('sha256').update(state).digest('hex')
const EXPIRES_MS = 15 * 60 * 1000
const expired = () => new IntegrationSetupError('This setup link expired or was already used. Start again in Gamut.')

async function attempt(state: string) {
  const id = state.split('.')[0]
  if (!/^[0-9a-f-]{36}$/.test(id) || state.length > 200) throw expired()
  let value
  try { value = await readGitHubIntegration(id) } catch { throw expired() }
  if (!value.config.pending || value.config.pending.stateHash !== hash(state) || value.config.pending.expiresAt <= Date.now() || value.config.pending.claimed) throw expired()
  return value
}
function installationUrl(app: NonNullable<GitHubConfig['app']>, state: string) {
  return `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(state)}`
}

export const githubSetup: IntegrationProviderSetup = {
  async prepare(input, context) {
    const { organization } = githubSetupInputSchema.parse(input)
    return { config: githubConfigSchema.parse({ redirectUri: context.callbackUrl, organization }), status: 'disconnected' }
  },
  authorize: {
    inputSchema: githubAuthorizationInputSchema,
    async run(record, _input, context) {
      const state = `${record.id}.${randomUUID()}`
      const config = await updateGitHubConfig(record.id, latest => {
        if (!latest.relay) throw new IntegrationSetupError('This integration needs a webhook relay')
        return { ...latest, redirectUri: context.callbackUrl, authorizationVersion: randomUUID(), authorizationError: undefined,
          pending: { stateHash: hash(state), expiresAt: Date.now() + EXPIRES_MS, phase: latest.app ? 'installation' : 'manifest', claimed: false } }
      })
      return { url: config.app ? installationUrl(config.app, state) : `${context.callbackUrl.replace(/\/callback$/, '/launch')}?state=${encodeURIComponent(state)}` }
    },
  },
  async launch(state) {
    const { row, config } = await attempt(state)
    if (config.pending?.phase !== 'manifest' || !config.relay) throw expired()
    const url = config.organization
      ? `https://github.com/organizations/${encodeURIComponent(config.organization)}/settings/apps/new`
      : 'https://github.com/settings/apps/new'
    return { url: `${url}?state=${encodeURIComponent(state)}`, fields: { manifest: JSON.stringify({
      name: (row.name ?? row.agentSlug).slice(0, 34), url: 'https://gamutagents.com',
      description: 'An agent with its own GitHub identity, managed in Gamut.', public: false,
      hook_attributes: { url: config.relay.url, active: true },
      redirect_url: config.redirectUri,
      // Each installation attempt supplies fresh state in installationUrl.
      setup_url: config.redirectUri, setup_on_update: true,
      request_oauth_on_install: false,
      default_permissions: { contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read' },
      default_events: ['issues', 'issue_comment', 'pull_request', 'pull_request_review', 'pull_request_review_comment'],
    }) } }
  },
  async callback({ state, code, error, parameters }) {
    const { row, config } = await attempt(state)
    if (error) {
      await updateGitHubConfig(row.id, latest => latest.pending?.stateHash === hash(state)
        ? { ...latest, pending: undefined, authorizationError: 'GitHub setup was cancelled. Start again when ready.' } : latest)
      return { cancelled: true }
    }
    await updateGitHubConfig(row.id, latest => {
      if (latest.pending?.stateHash !== hash(state) || latest.pending.claimed || latest.pending.expiresAt <= Date.now()) throw expired()
      return { ...latest, pending: { ...latest.pending, claimed: true } }
    })
    try {
      if (config.pending?.phase === 'manifest') {
        if (!code || !/^[a-zA-Z0-9_-]{1,256}$/.test(code)) throw new IntegrationSetupError('GitHub did not return an app creation code')
        const app = await githubRequest(`/app-manifests/${encodeURIComponent(code)}/conversions`, githubManifestResultSchema, undefined, {})
        if (config.organization && app.owner.login.toLowerCase() !== config.organization.toLowerCase()) throw new IntegrationSetupError('The app belongs to a different GitHub organization')
        const saved = await updateGitHubConfig(row.id, latest => {
          if (latest.authorizationVersion !== config.authorizationVersion || latest.pending?.stateHash !== hash(state)) throw expired()
          return { ...latest, app: { id: String(app.id), slug: app.slug, name: app.name, owner: app.owner.login, privateKey: app.pem, webhookSecret: app.webhook_secret },
            pending: { ...latest.pending, phase: 'installation', claimed: false } }
        })
        return { redirectUrl: installationUrl(saved.app!, state) }
      }
      const { installation_id: installationId } = githubInstallCallbackSchema.parse(parameters)
      if (!config.app || !config.relay) throw expired()
      // Never trust the callback's installation ID: authenticate as this app and
      // require the private app's owning account. Reinstallation may get a new ID.
      const installation = await githubRequest(`/app/installations/${installationId}`, githubInstallationSchema, githubAppJwt(config.app))
      if (String(installation.app_id) !== config.app.id || installation.account.login.toLowerCase() !== config.app.owner.toLowerCase()) throw new IntegrationSetupError('Choose the account that owns this GitHub App')
      if (installation.suspended_at) throw new IntegrationSetupError('Unsuspend this GitHub App installation before reconnecting')
      for (const permission of ['contents', 'issues', 'pull_requests']) {
        if (installation.permissions[permission] !== 'write') throw new IntegrationSetupError('Approve Contents, Issues and Pull requests write permissions in GitHub')
      }
      const bot = await githubRequest(`/users/${encodeURIComponent(`${config.app.slug}[bot]`)}`, githubAccountSchema)
      if (bot.type !== 'Bot') throw new IntegrationSetupError('GitHub did not return the app bot identity')
      // Provider registration must not initialize the relay and its runtime dependencies.
      const { getWebhookRelay } = await import('../../webhook-relay')
      await getWebhookRelay().updateEndpoint(config.relay.scope, config.relay.endpointId, { verification: {
        algorithm: 'hmac-sha256', encoding: 'hex', header: 'x-hub-signature-256', prefix: 'sha256=', template: '{body}', secret: config.app.webhookSecret,
      } })
      await updateGitHubConfig(row.id, latest => {
        if (latest.authorizationVersion !== config.authorizationVersion || latest.pending?.stateHash !== hash(state)) throw expired()
        return { ...latest, installation: { id: installation.id, account: installation.account.login, botId: bot.id }, pending: undefined, authorizationError: undefined, mcp: undefined }
      })
      // The shared callback resumes the integration and refreshes its MCP projection.
      return { integrationId: row.id }
    } catch (failure) {
      await updateGitHubConfig(row.id, latest => latest.authorizationVersion === config.authorizationVersion && latest.pending?.stateHash === hash(state)
        ? { ...latest, pending: undefined, authorizationError: 'GitHub setup could not finish. Start again to retry app installation.' } : latest)
      throw failure
    }
  },
}
