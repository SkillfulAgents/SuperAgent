import { IntegrationSetupError, type IntegrationProviderSetup } from '../../agent-integrations/setup-types'
import { linearConfigSchema } from './config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { parseTaskJson } from '../schemas'
import { getDataDir } from '../../config/data-dir'
import { captureException } from '../../error-reporting'
import { randomUUID } from 'node:crypto'
import { deleteAgentIntegration, listAgentIntegrations } from '../../services/agent-integration-service'
import { linearCredentialsSchema, linearAuthorizationInputSchema, linearSetupInputSchema } from './config'
import { getLinearConfig, updateLinearConfig, setLinearStatusForConfig } from './store'
import { hashOAuthState, linearAuthorization, linearAppCreationUrl } from './oauth'
import { exchangeLinearToken, LinearAuthorizationError, LinearClient, revokeLinearToken } from './client'

export { publicLinearIntegration } from './presentation'
export const linearSetup: IntegrationProviderSetup = {
  describe(context, name) {
    return { redirectUri: context.callbackUrl, creationUrl: linearAppCreationUrl(name ?? context.agentSlug, { redirectUri: context.callbackUrl }) }
  },
  async prepare(input, context) {
    // The host mints the relay endpoint for `transport: 'relay'`, before the
    // app exists, so the creation link can carry the webhook URL.
    const { transport } = linearSetupInputSchema.parse(input ?? {})
    return { config: { ...linearConfigSchema.parse({ redirectUri: context.callbackUrl, runOnStatusChange: false }), ...(transport ? { transport } : {}) }, status: 'disconnected' }
  },
  authorize: {
    inputSchema: linearAuthorizationInputSchema,
    async run(record, input) { return { url: await authorizeLinearSetup(record.id, input) } },
  },
  async callback({ state, code, error }) {
    if (!code || error) {
      await failLinearSetup(state, 'Authorization was cancelled. Reconnect when you are ready.')
      return { cancelled: true }
    }
    return { integrationId: await completeLinearSetup(state, code) }
  },
}

export async function authorizeLinearSetup(id: string, input: unknown): Promise<string> {
  const { webhookSecret: suppliedSecret, ...supplied } = linearAuthorizationInputSchema.parse(input)
  const config = await getLinearConfig(id)
  const credentials = linearCredentialsSchema.parse(supplied.clientId ? supplied : { clientId: config.clientId, clientSecret: config.clientSecret })
  const webhookSecret = suppliedSecret ?? config.webhookSecret
  // Without it no relayed event can be verified, so nothing would ever arrive.
  if (config.transport === 'relay' && !webhookSecret) throw new IntegrationSetupError('Paste the webhook signing secret from your Linear app')
  const authorization = linearAuthorization({ ...config, ...credentials })
  await updateLinearConfig(id, latest => ({ ...latest, ...credentials, ...(suppliedSecret ? { webhookSecret: suppliedSecret, webhookSecretStatus: undefined } : {}), oauth: authorization.oauth, authorizationError: undefined, authorizationPending: true, authorizationVersion: randomUUID() }))
  return authorization.url
}
/** Only the matching attempt can change its failure state; stale callbacks are inert. */
export async function failLinearSetup(state: string, message: string, allowClaimed = false): Promise<void> {
  const stateHash = hashOAuthState(state)
  const row = (await listAgentIntegrations()).find(row => {
    if (row.provider !== 'linear') return false
    try { return parseTaskJson(linearConfigSchema, row.config).oauth?.stateHash === stateHash } catch { return false }
  })
  if (!row) return
  let failed = false
  const config = await updateLinearConfig(row.id, latest => {
    failed = latest.oauth?.stateHash === stateHash && (allowClaimed || !latest.oauth.claimed)
    return failed ? { ...latest, oauth: undefined, authorizationPending: false, authorizationError: message } : latest
  })
  if (failed) await setLinearStatusForConfig(row.id, config, 'disconnected', message)
}
export async function completeLinearSetup(state: string, code: string): Promise<string> {
  const stateHash = hashOAuthState(state)
  const row = (await listAgentIntegrations()).find(row => {
    if (row.provider !== 'linear') return false
    try { return parseTaskJson(linearConfigSchema, row.config).oauth?.stateHash === stateHash } catch { return false }
  })
  if (!row) throw new IntegrationSetupError('Authorization expired. Start again in Gamut.')
  let config = await getLinearConfig(row.id)
  const oauth = config.oauth
  if (oauth?.claimed) throw new IntegrationSetupError('Authorization already used')
  if (!oauth || oauth.expiresAt <= Date.now() || !config.clientId || !config.clientSecret) {
    await failLinearSetup(state, 'Authorization expired. Start again to connect Linear.')
    throw new IntegrationSetupError('Authorization expired. Start again in Gamut.')
  }
  // Keep the expiration while exchange is in flight so the UI still shows pending.
  config = (await updateLinearConfig(row.id, latest => {
    if (latest.oauth?.stateHash !== stateHash || latest.oauth.claimed) throw new IntegrationSetupError('Authorization already used')
    return { ...latest, oauth: { ...latest.oauth, claimed: true } }
  }))
  try {
    const tokens = await exchangeLinearToken({ grant_type: 'authorization_code', code, client_id: config.clientId!,
      client_secret: config.clientSecret!, redirect_uri: config.redirectUri, code_verifier: oauth.verifier })
    const identity = await new LinearClient(undefined, tokens.accessToken).identity()
    const authorized = await updateLinearConfig(row.id, latest => {
      if (latest.authorizationVersion !== config.authorizationVersion) throw new IntegrationSetupError('A newer authorization attempt replaced this one')
      if (latest.identity && (latest.identity.appUserId !== identity.appUserId || latest.identity.workspaceId !== identity.workspaceId)) {
        throw new IntegrationSetupError('This is a different Linear app or workspace. Add a new integration instead.')
      }
      return { ...latest, identity, tokens, oauth: undefined, authorizationError: undefined, authorizationPending: false, mcp: undefined, authorizedAt: latest.authorizedAt ?? Date.now() }
    })
    await setLinearStatusForConfig(row.id, authorized, 'active', null)
    try {
      const { syncRemoteMcpAgents } = await import('../../services/connection-sync-service')
      await syncRemoteMcpAgents([row.agentSlug])
    }
    catch (error) { captureException(error, { tags: { component: 'linear-setup', operation: 'runtime-sync' } }) }
    return row.id
  } catch (error) {
    // Never expose provider responses or credentials in the public setup state.
    await failLinearSetup(state, 'Could not authorize Linear. Check the app credentials, workspace, and permissions, then reconnect.', true)
    if (error instanceof LinearAuthorizationError) throw new IntegrationSetupError(error.message)
    throw error
  }
}
export async function cleanupLinearIntegration(id: string): Promise<void> {
  // Local deletion must work offline and for damaged stored credentials.
  try {
    const config = await getLinearConfig(id)
    if (config.tokens) await revokeLinearToken(config.tokens.refreshToken)
  } catch {
    captureException(new Error('Could not revoke deleted Linear integration credentials'), { tags: { component: 'linear-setup', operation: 'revoke' }, extra: { integrationId: id } })
  }
  await fs.rm(path.join(getDataDir(), 'integration-attachments', z.uuid().parse(id)), { recursive: true, force: true })
}
export async function deleteLinearSetup(id: string): Promise<void> {
  await cleanupLinearIntegration(id)
  await deleteAgentIntegration(id)
}
