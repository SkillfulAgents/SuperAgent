/**
 * For a host whose agents run apart from the process that claims webhooks: this process claims
 * each active integration's endpoint and hands the events to the process that runs the
 * integration's agent, where its connection answers them (AgentIntegrationManager.acceptForwarded).
 */
import { getWebhookRelay, type RelayAcceptResult, type RelayConsumerHandle, type RelayEvent } from '../webhook-relay'
import { listStartupIntegrations } from './store'
import { readIntegrationRelay } from './transport'

export type ForwardIntegrationEvents = (
  agentSlug: string,
  integrationId: string,
  events: readonly RelayEvent[],
) => Promise<ReadonlyMap<string, RelayAcceptResult>>

const registrations = new Map<string, { handle: RelayConsumerHandle; agentSlug: string; forward: ForwardIntegrationEvents }>()

/** Claims for every active integration with webhooks, and stops claiming for the rest. Run before each relay pass. */
export async function syncIntegrationForwarding(forward: ForwardIntegrationEvents): Promise<void> {
  const wanted = new Map<string, { agentSlug: string; scope: string; endpointId: string }>()
  for (const integration of await listStartupIntegrations()) {
    let relay: ReturnType<typeof readIntegrationRelay>
    try {
      relay = readIntegrationRelay(integration.config)
    } catch {
      continue
    }
    if (relay) wanted.set(integration.id, { agentSlug: integration.agentSlug, scope: relay.scope, endpointId: relay.endpointId })
  }
  for (const [id, registration] of registrations) {
    if (wanted.has(id)) continue
    registration.handle.dispose()
    registrations.delete(id)
  }
  for (const [id, { agentSlug, scope, endpointId }] of wanted) {
    const existing = registrations.get(id)
    if (existing) {
      // The host may pass a new function each pass (one bound to that pass's request).
      existing.agentSlug = agentSlug
      existing.forward = forward
      existing.handle.update({ scope, endpointIds: [endpointId] })
      continue
    }
    const registration = { agentSlug, forward, handle: null as unknown as RelayConsumerHandle }
    registration.handle = getWebhookRelay().register({
      // Not the connection's own consumer id: a connection set up in this process registers that one.
      id: `forward:integration:${id}`,
      scope,
      endpointIds: [endpointId],
      accept: (events) => registration.forward(registration.agentSlug, id, events),
    })
    registrations.set(id, registration)
  }
}
