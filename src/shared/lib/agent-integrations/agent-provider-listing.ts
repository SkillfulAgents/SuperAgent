import { agentIntegrationRegistry } from './registry'
import { requiresRelay, supportedTransports } from './transport'
import { getWebhookRelay } from '../webhook-relay'
import { findProvisioner } from '../team-directory/provisioning'

export interface AgentProviderListing {
  provider: string
  name: string
  /** How the agent sets it up; absent when `unavailable` says why it can't. */
  guide?: string
  unavailable?: string
  /** A connected team directory creates this provider's app, in the setup form only. */
  oneClickWorkspace?: string
}

/** Every integration provider, with how an agent sets it up on this host or why it can't. */
export async function listAgentIntegrationProviders(): Promise<{ providers: AgentProviderListing[]; webhookRelay: boolean }> {
  const webhookRelay = getWebhookRelay().snapshot().available
  const providers = await Promise.all(agentIntegrationRegistry.listDefinitions().map(async (definition): Promise<AgentProviderListing> => {
    const { provider, name } = definition
    const setup = agentIntegrationRegistry.getProvider(provider).setup
    const unavailable = !setup || !(await agentIntegrationRegistry.isAvailable(provider)) ? 'Not available on this host.'
      : requiresRelay(supportedTransports(definition)) && !webhookRelay ? 'Needs a webhook relay, which this host does not have.'
        : null
    if (unavailable) return { provider, name, unavailable }
    // A connected team directory creates this provider's app for the user in the
    // setup form; an agent can't use it, so it hands the setup over instead.
    const oneClick = webhookRelay && supportedTransports(definition).includes('relay') ? await findProvisioner(provider) : null
    return {
      provider, name,
      guide: setup?.agentGuide ?? `Pass its fields in config: ${definition.setup.credentialFields.join(', ') || 'none'}.`,
      ...(oneClick ? { oneClickWorkspace: oneClick.workspace } : {}),
    }
  }))
  return { providers, webhookRelay }
}
