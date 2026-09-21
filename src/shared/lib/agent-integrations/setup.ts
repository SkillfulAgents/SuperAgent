import { z } from 'zod'
import { agentIntegrationRegistry } from './registry'
import { IntegrationSetupError, type IntegrationSetupContext } from './setup-types'

export function getIntegrationSetup(provider: string) {
  const setup = agentIntegrationRegistry.getDefinition(provider) && agentIntegrationRegistry.getProvider(provider).setup
  if (!setup) throw new IntegrationSetupError('Provider setup is unavailable')
  return setup
}
export function integrationSetupContext(provider: string, origin: string, agentSlug: string, userId?: string): IntegrationSetupContext {
  const baseUrl = process.env.HOST_PUBLIC_URL?.trim().replace(/\/+$/, '') || origin
  return { agentSlug, userId, callbackUrl: `${baseUrl}/api/agent-integrations/providers/${encodeURIComponent(provider)}/callback` }
}
export async function prepareIntegrationSetup(provider: string, input: unknown, context: IntegrationSetupContext, fromAgent = false) {
  const setup = getIntegrationSetup(provider)
  if (fromAgent && !setup.allowAgentCreation) throw new IntegrationSetupError('This account must be set up by its owner in the agent integration page.', 403)
  return setup.prepare(input, context)
}
export async function testIntegrationCredentials(provider: string, input: unknown) {
  const setup = getIntegrationSetup(provider)
  if (!setup.testCredentials) throw new IntegrationSetupError('This provider requires interactive authorization')
  return setup.testCredentials(input)
}
export function setupError(error: unknown): { error: string; status: 400 | 401 | 403 | 404 | 429 } | undefined {
  if (error instanceof IntegrationSetupError) return { error: error.message, status: error.status }
  if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? 'Invalid integration settings', status: 400 }
}
