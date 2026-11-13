import { z } from 'zod'
import { resolvePublicAppBaseUrl } from './app-link'
import { agentIntegrationRegistry } from './registry'
import { IntegrationSetupError, type IntegrationSetupContext } from './setup-types'
import { captureException } from '../error-reporting'
import { disableIntegrationRelay, integrationRelayName, provisionIntegrationRelay, updateIntegrationRelayVerification } from './relay-transport'
import { createAgentApp } from '../team-directory/provisioning'
import { requiresRelay, supportedTransports } from './transport'
import type { IntegrationStatus } from './types'

export async function assertIntegrationAvailable(provider: string): Promise<void> {
  if (!await agentIntegrationRegistry.isAvailable(provider)) throw new IntegrationSetupError('This add-on is unavailable on this host', 400)
}

export function getIntegrationSetup(provider: string) {
  const setup = agentIntegrationRegistry.getDefinition(provider) && agentIntegrationRegistry.getProvider(provider).setup
  if (!setup) throw new IntegrationSetupError('Provider setup is unavailable')
  return setup
}
export async function integrationSetupContext(provider: string, request: Request | string, agentSlug: string, userId?: string): Promise<IntegrationSetupContext> {
  const baseUrl = await resolvePublicAppBaseUrl(request)
  if (!baseUrl) throw new IntegrationSetupError('Public app URL is unavailable')
  return { agentSlug, userId, callbackUrl: `${baseUrl}/api/agent-integrations/providers/${encodeURIComponent(provider)}/callback` }
}
export interface PreparedIntegrationSetup {
  config: Record<string, unknown>
  status?: IntegrationStatus
  /** Undoes what preparing provisioned, when the installation isn't created after all. */
  release(): Promise<void>
}
/**
 * `provision` in the setup input asks a connected team directory to create the
 * installation's app (team-directory/provisioning.ts): the host takes it out
 * of what the provider sees, and creates the app once the webhook URL exists.
 */
export const provisionRequestSchema = z.object({
  directoryId: z.string().min(1),
  /** What the app shows of its agent. */
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** The agent's avatar as a square PNG, base64. */
  icon: z.string().max(4_000_000).optional(),
})
export type ProvisionRequest = z.infer<typeof provisionRequestSchema>

export function decodeIcon(icon: string | undefined): Uint8Array | undefined {
  if (!icon) return undefined
  const bytes = Buffer.from(icon, 'base64')
  // A PNG, by its signature; anything else is not sent on.
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) throw new IntegrationSetupError('The icon must be a PNG')
  return new Uint8Array(bytes)
}

function takeProvision(input: unknown): { input: unknown; provision?: ProvisionRequest } {
  if (!input || typeof input !== 'object' || !('provision' in input)) return { input }
  const { provision, ...rest } = input as Record<string, unknown>
  return { input: rest, provision: provisionRequestSchema.parse(provision) }
}

export async function prepareIntegrationSetup(provider: string, rawInput: unknown, context: IntegrationSetupContext, fromAgent = false): Promise<PreparedIntegrationSetup> {
  await assertIntegrationAvailable(provider)
  const setup = getIntegrationSetup(provider)
  if (fromAgent && !setup.allowAgentCreation) throw new IntegrationSetupError('This account must be set up by its owner in the agent’s Add-ons section.', 403)
  const { input, provision } = takeProvision(rawInput)
  if (provision && fromAgent) throw new IntegrationSetupError('An agent can’t create apps; its owner sets them up in the agent’s Add-ons section.', 403)
  const { relay: wantsRelay, verification, ...prepared } = await setup.prepare(input, context)
  const definition = agentIntegrationRegistry.getDefinition(provider)!
  const transports = supportedTransports(definition)
  if (wantsRelay && !transports.includes('relay')) throw new IntegrationSetupError(`${definition.name} can't receive webhooks`)
  if (provision && !wantsRelay) throw new IntegrationSetupError('A created app receives its events through webhooks; set it up with webhooks.')
  if (!wantsRelay && !requiresRelay(transports)) return { ...prepared, release: async () => {} }
  // The URL exists before the installation, so provider setup can hand it out.
  const relay = await provisionIntegrationRelay(integrationRelayName(definition.name, context.agentSlug), context.userId, verification)
  const releaseRelay = async () => {
    try {
      await disableIntegrationRelay(relay)
    } catch (error) {
      captureException(error, { tags: { component: 'agent-integration', operation: 'release-relay-endpoint' }, extra: { provider, endpointId: relay.endpointId } })
    }
  }
  if (!provision) return { ...prepared, config: { ...prepared.config, relay }, release: releaseRelay }

  // The app is created with the webhook URL in it, and its secret then signs what arrives there.
  let app: Awaited<ReturnType<typeof createAgentApp>>
  try {
    app = await createAgentApp({
      directoryId: provision.directoryId,
      integrationProvider: provider,
      identity: {
        name: provision.name,
        ...(provision.description ? { description: provision.description } : {}),
        ...(provision.backgroundColor ? { backgroundColor: provision.backgroundColor } : {}),
        ...(provision.icon ? { icon: decodeIcon(provision.icon) } : {}),
      },
      webhookUrl: relay.url,
      redirectUrl: context.callbackUrl,
    })
    if (app.verification) await updateIntegrationRelayVerification(relay, app.verification)
  } catch (error) {
    await releaseRelay()
    throw error
  }
  return {
    ...prepared,
    config: { ...prepared.config, ...app.config, relay },
    release: async () => {
      await app.release()
      await releaseRelay()
    },
  }
}
export async function testIntegrationCredentials(provider: string, input: unknown) {
  await assertIntegrationAvailable(provider)
  const setup = getIntegrationSetup(provider)
  if (!setup.testCredentials) throw new IntegrationSetupError('Credentials are verified when this add-on connects')
  return setup.testCredentials(input)
}
export function setupError(error: unknown): { error: string; status: 400 | 403 | 404 | 429 } | undefined {
  if (error instanceof IntegrationSetupError) return { error: error.message, status: error.status }
  if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? 'Invalid add-on settings', status: 400 }
}
