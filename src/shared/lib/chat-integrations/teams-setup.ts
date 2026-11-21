import { randomBytes } from 'node:crypto'
import { resolveInternetAppBaseUrl } from '../agent-integrations/app-link'
import { IntegrationSetupError, type IntegrationProviderSetup } from '../agent-integrations/setup-types'
import { getWebhookRelay } from '../webhook-relay'
import { CHAT_AGENT_GUIDES } from './agent-guides'
import { teamsConfigSchema, withoutHostOwnedConfig, type TeamsConfig } from './config-schema'
import { inputSchema } from './setup-schema'

function messagingBase(): string | undefined {
  const host = resolveInternetAppBaseUrl()
  return host ? `${host}/api/teams/messages` : undefined
}

function configuredGateway(): string | undefined {
  const url = process.env.TEAMS_RELAY_GATEWAY_URL?.trim()
  return url && getWebhookRelay().snapshot().available ? url : undefined
}

export async function testTeamsCredentials(config: TeamsConfig): Promise<void> {
  const { TeamsApi } = await import('./teams-api')
  try {
    await new TeamsApi(config).checkCredentials()
  } catch {
    throw new IntegrationSetupError('Microsoft could not verify these credentials. Check the tenant ID, application ID, and client secret value for this Teams bot.')
  }
}

export const teamsSetup: IntegrationProviderSetup = {
  agentGuide: CHAT_AGENT_GUIDES.teams,
  describe() {
    const teamsMessagingBaseUrl = messagingBase()
    return teamsMessagingBaseUrl ? { teamsMessagingBaseUrl } : { teamsRelayAvailable: !!configuredGateway() }
  },
  async testCredentials(input) {
    await testTeamsCredentials(teamsConfigSchema.parse(input))
    return { valid: true }
  },
  async prepare(input) {
    const config = teamsConfigSchema.parse(withoutHostOwnedConfig('teams', inputSchema.parse(input)))
    await testTeamsCredentials(config)
    if (config.deliveryMode === 'socket') return { config }
    const base = messagingBase()
    if (base) return { config: { ...config, messagingEndpoint: `${base}/${config.appId}` } }

    const gateway = configuredGateway()
    if (!gateway) throw new IntegrationSetupError('Configure a public HTTPS address (HOST_PUBLIC_URL) or a Teams relay gateway for this Gamut host.')
    const secret = randomBytes(32).toString('hex')
    return {
      config, relay: true,
      verification: { algorithm: 'hmac-sha256', encoding: 'hex', template: '{body}', header: 'X-Gamut-Teams-Signature', secret },
      async bindRelay(relay) {
        const { createTeamsGatewayEndpoint } = await import('./teams-relay-gateway-client')
        const messagingEndpoint = await createTeamsGatewayEndpoint(gateway, {
          tenantId: config.tenantId, appId: config.appId, relayUrl: relay.url, secret,
        })
        return { messagingEndpoint }
      },
    }
  },
}
