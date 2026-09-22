import type { ChatIntegration } from '../../db/schema'
import { parseTaskJson } from '../schemas'
import { linearConfigSchema } from './config'
import { linearAppCreationUrl } from './oauth'

export function publicLinearIntegration(row: ChatIntegration) {
  if (row.provider !== 'linear') throw new Error('Linear integration not found')
  const config = parseTaskJson(linearConfigSchema, row.config)
  const pending = config.authorizationPending && !!config.oauth && config.oauth.expiresAt > Date.now()
  const reconnectRequired = !pending && (config.authorizationPending || !!config.authorizationError || (!!config.identity && !config.tokens))
  const authorizationState = pending ? 'pending' : reconnectRequired ? 'reconnect_needed' : config.tokens ? 'connected' : 'setup_required'
  const authorizationMessage = reconnectRequired ? config.authorizationError ?? (config.authorizationPending
    ? 'Authorization expired. Start again to connect Linear.' : 'Linear access expired or was revoked. Reconnect this account.') : null
  return { id: row.id, agentSlug: row.agentSlug, provider: 'linear' as const, name: config.identity?.appName ?? row.name,
    status: row.status, errorMessage: row.errorMessage, identity: config.identity ?? null,
    outbound: { available: config.mcp?.available ?? false, message: config.tokens && !config.mcp?.available ? 'Linear tools are temporarily unavailable. Incoming work is retained and will retry.' : null },
    authorized: authorizationState === 'connected', authorizationState, authorizationMessage,
    ...(pending ? { authorizationPendingUntil: config.oauth?.expiresAt } : {}),
    canReconnect: !!config.clientId && !!config.clientSecret, runOnStatusChange: config.runOnStatusChange,
    setup: { creationUrl: linearAppCreationUrl(row.name ?? row.agentSlug, config), redirectUri: config.redirectUri } }
}
