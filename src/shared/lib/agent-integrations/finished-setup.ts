import { agentRegistry, updateConfigDoc } from '@shared/lib/agent-actor'
import { background } from '@shared/lib/background'
import { listAgentIntegrations } from '@shared/lib/services/agent-integration-service'
import { toPublicAgentIntegration } from './serialization'
import type { AgentIntegrationProvider } from './provider-types'
import { finishedSetupSchema, setupProviderSchema, type FinishedSetup } from './finished-setup-schema'
import { channelSetupComplete, type PublicAgentIntegration } from './public'

const previousFilename = 'finished-setup.json'

async function setupConfig(slug: string) {
  const { config, files } = agentRegistry.get(slug)
  const previous = await files.getDoc(previousFilename)
  if (previous) {
    // Keep a newer copy if another request already migrated and edited it.
    await updateConfigDoc(config, 'finishSetup', current => {
      if (current) return current
      try {
        return finishedSetupSchema.parse(JSON.parse(new TextDecoder().decode(previous)))
      } catch (cause) {
        throw new Error(`Could not import setup reminders from ${previousFilename}`, { cause })
      }
    })
    await files.delete(previousFilename)
  }
  return config
}

/** Reconcile against stored installations, including OAuth completed in another window. */
export async function readFinishedSetup(slug: string): Promise<FinishedSetup> {
  const doc = await updateConfigDoc(await setupConfig(slug), 'finishSetup', async current => {
    if (!current?.steps.length) return current
    const integrations = await listAgentIntegrations(slug)
    const complete = new Set(integrations.map(toPublicAgentIntegration).filter(channelSetupComplete).map(row => row.provider))
    const steps = current.steps.filter(step => !complete.has(step.provider))
    return steps.length === current.steps.length ? current : { steps }
  })
  return doc ?? { steps: [] }
}

export async function setChannelDeferred(slug: string, provider: AgentIntegrationProvider, deferred: boolean) {
  await updateConfigDoc(await setupConfig(slug), 'finishSetup', (current): FinishedSetup | null => {
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
