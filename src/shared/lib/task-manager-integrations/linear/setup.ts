import { removeTaskAttachments } from '../attachments'
import { captureException } from '../../error-reporting'
import { randomUUID } from 'node:crypto'
import { createChatIntegration, deleteChatIntegration, getChatIntegration, listChatIntegrations, updateChatIntegrationStatus } from '../../services/chat-integration-service'
import { linearConfigSchema, linearCredentialsSchema, linearAuthorizationInputSchema } from './config'
import { getLinearConfig, updateLinearConfig } from './store'
import { hashOAuthState, linearAppCreationUrl, linearAuthorization } from './oauth'
import { exchangeLinearToken, LinearClient, revokeLinearToken } from './client'

export function publicLinearIntegration(id: string) {
  const row = getChatIntegration(id)
  if (!row || row.provider !== 'linear') throw new Error('Linear integration not found')
  const config = getLinearConfig(id)
  const pending = config.authorizationPending && !!config.oauth && config.oauth.expiresAt > Date.now()
  const reconnectRequired = !pending && (config.authorizationPending || !!config.authorizationError || (!!config.identity && !config.tokens))
  const authorizationState = pending ? 'pending' : reconnectRequired ? 'reconnect_needed' : config.tokens ? 'connected' : 'setup_required'
  const authorizationMessage = reconnectRequired ? config.authorizationError ?? (config.authorizationPending
    ? 'Authorization expired. Start again to connect Linear.' : 'Linear access expired or was revoked. Reconnect this account.') : null
  return { id: row.id, agentSlug: row.agentSlug, provider: 'linear' as const, name: config.identity?.appName ?? row.name,
    status: row.status, errorMessage: row.errorMessage, identity: config.identity ?? null,
    authorized: authorizationState === 'connected', authorizationState, authorizationMessage,
    canReconnect: !!config.clientId && !!config.clientSecret, runOnStatusChange: config.runOnStatusChange,
    setup: { creationUrl: linearAppCreationUrl(row.name ?? row.agentSlug, config), redirectUri: config.redirectUri } }
}
export async function createLinearSetup(agentSlug: string, name: string, userId: string, origin: string) {
  // TLS can terminate at a reverse proxy before the request reaches this host.
  const publicBaseUrl = process.env.HOST_PUBLIC_URL?.trim().replace(/\/+$/, '') || origin
  const config = linearConfigSchema.parse({ redirectUri: `${publicBaseUrl}/api/agent-integrations/linear/callback`, runOnStatusChange: false })
  const id = createChatIntegration({ agentSlug, provider: 'linear', name, config, createdByUserId: userId, sessionTimeout: null })
  updateChatIntegrationStatus(id, 'disconnected', null)
  return publicLinearIntegration(id)
}

export async function authorizeLinearSetup(id: string, input: unknown): Promise<string> {
  const supplied = linearAuthorizationInputSchema.parse(input)
  const config = getLinearConfig(id)
  const credentials = linearCredentialsSchema.parse(supplied.clientId ? supplied : { clientId: config.clientId, clientSecret: config.clientSecret })
  const authorization = linearAuthorization({ ...config, ...credentials })
  updateLinearConfig(id, latest => ({ ...latest, ...credentials, oauth: authorization.oauth, authorizationError: undefined, authorizationPending: true, authorizationVersion: randomUUID() }))
  return authorization.url
}
/** Only the matching attempt can change its failure state; stale callbacks are inert. */
export function failLinearSetup(state: string, message: string, allowClaimed = false): void {
  const stateHash = hashOAuthState(state)
  const row = listChatIntegrations().find(row => {
    if (row.provider !== 'linear') return false
    try { return getLinearConfig(row.id).oauth?.stateHash === stateHash } catch { return false }
  })
  if (!row || (!allowClaimed && getLinearConfig(row.id).oauth?.claimed)) return
  updateLinearConfig(row.id, latest => ({ ...latest, oauth: undefined, authorizationPending: false, authorizationError: message }))
  updateChatIntegrationStatus(row.id, 'disconnected', message)
}
export async function completeLinearSetup(state: string, code: string): Promise<string> {
  const stateHash = hashOAuthState(state)
  const row = listChatIntegrations().find(row => {
    if (row.provider !== 'linear') return false
    try { return getLinearConfig(row.id).oauth?.stateHash === stateHash } catch { return false }
  })
  if (!row) throw new Error('Authorization expired. Start again in Gamut.')
  let config = getLinearConfig(row.id)
  const oauth = config.oauth
  if (oauth?.claimed) throw new Error('Authorization already used')
  if (!oauth || oauth.expiresAt <= Date.now() || !config.clientId || !config.clientSecret) {
    failLinearSetup(state, 'Authorization expired. Start again to connect Linear.')
    throw new Error('Authorization expired. Start again in Gamut.')
  }
  // Keep the expiration while exchange is in flight so the UI still shows pending.
  config = updateLinearConfig(row.id, latest => {
    if (latest.oauth?.stateHash !== stateHash || latest.oauth.claimed) throw new Error('Authorization already used')
    return { ...latest, oauth: { ...latest.oauth, claimed: true } }
  })
  try {
    const tokens = await exchangeLinearToken({ grant_type: 'authorization_code', code, client_id: config.clientId!,
      client_secret: config.clientSecret!, redirect_uri: config.redirectUri, code_verifier: oauth.verifier })
    const identity = await new LinearClient(undefined, tokens.accessToken).identity()
    updateLinearConfig(row.id, latest => {
      if (latest.authorizationVersion !== config.authorizationVersion) throw new Error('A newer authorization attempt replaced this one')
      if (latest.identity && (latest.identity.appUserId !== identity.appUserId || latest.identity.workspaceId !== identity.workspaceId)) {
        throw new Error('This is a different Linear app or workspace. Add a new integration instead.')
      }
      return { ...latest, identity, tokens, oauth: undefined, authorizationError: undefined, authorizationPending: false, authorizedAt: latest.authorizedAt ?? Date.now() }
    })
    updateChatIntegrationStatus(row.id, 'active', null)
    return row.id
  } catch (error) {
    // Never expose provider responses or credentials in the public setup state.
    failLinearSetup(state, 'Could not authorize Linear. Check the app credentials, workspace, and permissions, then reconnect.', true)
    throw error
  }
}
export async function cleanupLinearIntegration(id: string): Promise<void> {
  // Local deletion must work offline and for damaged stored credentials.
  try {
    const config = getLinearConfig(id)
    if (config.tokens) await revokeLinearToken(config.tokens.refreshToken)
  } catch {
    captureException(new Error('Could not revoke deleted Linear integration credentials'), { tags: { component: 'linear-setup', operation: 'revoke' }, extra: { integrationId: id } })
  }
  await removeTaskAttachments(id)
}
export async function deleteLinearSetup(id: string): Promise<void> {
  await cleanupLinearIntegration(id)
  deleteChatIntegration(id)
}
