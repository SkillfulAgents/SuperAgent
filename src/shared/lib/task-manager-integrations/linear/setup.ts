import { randomUUID } from 'node:crypto'
import { createChatIntegration, deleteChatIntegration, getChatIntegration, listChatIntegrations, updateChatIntegrationStatus } from '../../services/chat-integration-service'
import { createPlatformWebhookEndpoint, disablePlatformWebhookEndpoint, updatePlatformWebhookEndpoint } from '../../services/webhook-endpoints-client'
import { resolvePlatformMemberForCandidates } from '../../services/webhook-trigger-service'
import { getStoredPlatformMemberId } from '../../services/platform-auth-service'
import { isAuthMode } from '../../auth/mode'
import { linearConfigSchema, linearCredentialsSchema } from './config'
import { getLinearConfig, updateLinearConfig } from './store'
import { hashOAuthState, linearAppCreationUrl, linearAuthorization } from './oauth'
import { exchangeLinearToken, LinearClient, revokeLinearToken } from './client'

export function publicLinearIntegration(id: string) {
  const row = getChatIntegration(id)
  if (!row || row.provider !== 'linear') throw new Error('Linear integration not found')
  const config = getLinearConfig(id)
  return { id: row.id, agentSlug: row.agentSlug, provider: 'linear' as const, name: config.identity?.appName ?? row.name,
    status: row.status, errorMessage: row.errorMessage, identity: config.identity ?? null,
    authorized: !!config.tokens && !config.authorizationPending, runOnStatusChange: config.runOnStatusChange,
    setup: { creationUrl: linearAppCreationUrl(row.name ?? row.agentSlug, config), webhookUrl: config.webhookUrl, redirectUri: config.redirectUri } }
}
export async function createLinearSetup(agentSlug: string, name: string, userId: string, origin: string) {
  const memberId = resolvePlatformMemberForCandidates([userId])?.memberId ?? (!isAuthMode() ? getStoredPlatformMemberId() : null)
  if (!memberId) throw new Error('Sign in to your Gamut account to receive Linear events')
  const endpoint = await createPlatformWebhookEndpoint(memberId, { name: `Linear: ${name}` })
  try {
    const config = linearConfigSchema.parse({ endpointId: endpoint.id, webhookUrl: endpoint.url, memberId,
      redirectUri: `${origin}/api/agent-integrations/linear/callback`, runOnStatusChange: false })
    const id = createChatIntegration({ agentSlug, provider: 'linear', name, config, createdByUserId: userId, sessionTimeout: null })
    updateChatIntegrationStatus(id, 'disconnected', null)
    return publicLinearIntegration(id)
  } catch (error) {
    await disablePlatformWebhookEndpoint(memberId, endpoint.id)
    throw error
  }
}
export async function authorizeLinearSetup(id: string, input: unknown): Promise<string> {
  const credentials = linearCredentialsSchema.parse(input)
  const config = getLinearConfig(id)
  await updatePlatformWebhookEndpoint(config.memberId, config.endpointId, { verification: {
    algorithm: 'hmac-sha256', encoding: 'hex', header: 'Linear-Signature', template: '{body}', secret: credentials.webhookSecret,
  } })
  const authorization = linearAuthorization({ ...config, ...credentials })
  updateLinearConfig(id, latest => ({ ...latest, ...credentials, oauth: authorization.oauth, authorizationPending: true, authorizationVersion: randomUUID() }))
  return authorization.url
}
export async function completeLinearSetup(state: string, code: string): Promise<string> {
  const stateHash = hashOAuthState(state)
  const row = listChatIntegrations().find(row => row.provider === 'linear' && getLinearConfig(row.id).oauth?.stateHash === stateHash)
  if (!row) throw new Error('Authorization expired. Start again in Gamut.')
  let config = getLinearConfig(row.id)
  const oauth = config.oauth
  if (!oauth || oauth.expiresAt < Date.now() || !config.clientId || !config.clientSecret) throw new Error('Authorization expired. Start again in Gamut.')
  // Claim state synchronously before token exchange: one callback can consume it.
  config = updateLinearConfig(row.id, latest => {
    if (latest.oauth?.stateHash !== stateHash) throw new Error('Authorization already used')
    return { ...latest, oauth: undefined }
  })
  const tokens = await exchangeLinearToken({ grant_type: 'authorization_code', code, client_id: config.clientId!,
    client_secret: config.clientSecret!, redirect_uri: config.redirectUri, code_verifier: oauth.verifier })
  const identity = await new LinearClient(undefined, tokens.accessToken).identity()
  updateLinearConfig(row.id, latest => {
    if (latest.authorizationVersion !== config.authorizationVersion) throw new Error('A newer authorization attempt replaced this one')
    if (latest.identity && (latest.identity.appUserId !== identity.appUserId || latest.identity.workspaceId !== identity.workspaceId)) {
      throw new Error('This is a different Linear app or workspace. Add a new integration instead.')
    }
    return { ...latest, identity, tokens, authorizationPending: false, authorizedAt: Date.now() }
  })
  updateChatIntegrationStatus(row.id, 'active', null)
  return row.id
}
export async function cleanupLinearIntegration(id: string): Promise<void> {
  const config = getLinearConfig(id)
  // Disable the public endpoint before deleting its only cleanup reference.
  await disablePlatformWebhookEndpoint(config.memberId, config.endpointId)
  if (config.tokens) await revokeLinearToken(config.tokens.refreshToken)
}
export async function deleteLinearSetup(id: string): Promise<void> {
  await cleanupLinearIntegration(id)
  deleteChatIntegration(id)
}
