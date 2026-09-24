import { z } from 'zod'
import { resolvePublicAppBaseUrl } from './app-link'
import { agentIntegrationRegistry } from './registry'
import { IntegrationSetupError, type IntegrationSetupContext } from './setup-types'
import { captureException } from '../error-reporting'
import { disableIntegrationRelay, provisionIntegrationRelay } from './relay-transport'
import { readIntegrationTransport, requiresRelay, supportedTransports } from './transport'
import type { IntegrationStatus } from './types'

export function getIntegrationSetup(provider: string) {
  const setup = agentIntegrationRegistry.getDefinition(provider) && agentIntegrationRegistry.getProvider(provider).setup
  if (!setup) throw new IntegrationSetupError('Provider setup is unavailable')
  return setup
}
export function integrationSetupContext(provider: string, request: Request | string, agentSlug: string, userId?: string): IntegrationSetupContext {
  const baseUrl = resolvePublicAppBaseUrl(request)
  if (!baseUrl) throw new IntegrationSetupError('Public app URL is unavailable')
  return { agentSlug, userId, callbackUrl: `${baseUrl}/api/agent-integrations/providers/${encodeURIComponent(provider)}/callback` }
}
export interface PreparedIntegrationSetup {
  config: Record<string, unknown>
  status?: IntegrationStatus
  /** Undoes what preparing provisioned, when the installation isn't created after all. */
  release(): Promise<void>
}
export async function prepareIntegrationSetup(provider: string, input: unknown, context: IntegrationSetupContext, fromAgent = false): Promise<PreparedIntegrationSetup> {
  const setup = getIntegrationSetup(provider)
  if (fromAgent && !setup.allowAgentCreation) throw new IntegrationSetupError('This account must be set up by its owner in the agent integration page.', 403)
  const prepared = await setup.prepare(input, context)
  const definition = agentIntegrationRegistry.getDefinition(provider)!
  const transports = supportedTransports(definition)
  const { transport } = readIntegrationTransport({ transport: requiresRelay(transports) ? 'relay' : 'direct', ...prepared.config })
  if (!transports.includes(transport)) throw new IntegrationSetupError(`${definition.name} can't receive events over the ${transport === 'relay' ? 'webhook relay' : 'direct connection'}`)
  if (transport !== 'relay') return { ...prepared, release: async () => {} }
  // The URL exists before the installation, so provider setup can hand it out.
  const relay = await provisionIntegrationRelay(`${definition.name} integration for ${context.agentSlug}`, context.userId)
  return {
    ...prepared,
    config: { ...prepared.config, transport, relay },
    release: async () => {
      try {
        await disableIntegrationRelay(relay)
      } catch (error) {
        captureException(error, { tags: { component: 'agent-integration', operation: 'release-relay-endpoint' }, extra: { provider, endpointId: relay.endpointId } })
      }
    },
  }
}
export async function testIntegrationCredentials(provider: string, input: unknown) {
  const setup = getIntegrationSetup(provider)
  if (!setup.testCredentials) throw new IntegrationSetupError('Credentials are verified when this integration connects')
  return setup.testCredentials(input)
}
export function setupError(error: unknown): { error: string; status: 400 | 403 | 404 | 429 } | undefined {
  if (error instanceof IntegrationSetupError) return { error: error.message, status: error.status }
  if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? 'Invalid integration settings', status: 400 }
}
