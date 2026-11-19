import { agentRegistry, updateConfigDoc } from '@shared/lib/agent-actor'
import { background } from '@shared/lib/background'
import { listAgentIntegrations } from '@shared/lib/services/agent-integration-service'
import { toPublicAgentIntegration } from './serialization'
import type { AgentIntegrationProvider } from './provider-types'
import { setupProviderSchema, type FinishedSetup } from './finished-setup-schema'
import { channelSetupComplete, type PublicAgentIntegration } from './public'

/** Reconcile against stored installations, including OAuth completed in another window. */
export async function readFinishedSetup(slug: string): Promise<FinishedSetup> {
  const doc = await updateConfigDoc(agentRegistry.get(slug).config, 'finishedSetup', async current => {
    if (!current?.steps.length) return current
    const integrations = await listAgentIntegrations(slug)
    const complete = new Set(integrations.map(toPublicAgentIntegration).filter(channelSetupComplete).map(row => row.provider))
    const steps = current.steps.filter(step => !complete.has(step.provider))
    return steps.length === current.steps.length ? current : { steps }
  })
  return doc ?? { steps: [] }
}

export async function setChannelDeferred(slug: string, provider: AgentIntegrationProvider, deferred: boolean) {
  await updateConfigDoc(agentRegistry.get(slug).config, 'finishedSetup', (current): FinishedSetup | null => {
    const steps = current?.steps ?? []
    if (steps.some(step => step.provider === provider) === deferred) return current
    return { steps: deferred ? [...steps, { type: 'channel', provider }] : steps.filter(step => step.provider !== provider) }
  })
}

/** A saved connection closes its reminder even when authorization finishes outside Agent Home. */
export function clearCompletedChannel(integration: PublicAgentIntegration) {
  const provider = setupProviderSchema.safeParse(integration.provider)
  if (provider.success && channelSetupComplete(integration)) {
    background(setChannelDeferred(integration.agentSlug, provider.data, false), { name: 'agent-integrations.clear-setup-reminder' })
  }
}
