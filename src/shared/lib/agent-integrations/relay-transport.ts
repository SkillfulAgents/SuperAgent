import { captureException } from '../error-reporting'
import { getStoredPlatformMemberId } from '../services/platform-auth-service'
import { resolvePlatformMemberForCandidates } from '../services/webhook-trigger-service'
import {
  LOCAL_RELAY_SCOPE,
  WebhookRelayUnavailableError,
  getWebhookRelay,
  type RelayAcceptResult,
  type RelayConsumerHandle,
  type RelayEvent,
  type WebhookRelayService,
} from '../webhook-relay'
import { WebhookEndpointsApiError } from '../webhook-relay/platform-endpoints-client'
import { IntegrationSetupError } from './setup-types'
import {
  integrationRelayBindingSchema,
  readIntegrationTransport,
  supportedTransports,
  type IntegrationRelayBinding,
  type IntegrationTransport,
  type IntegrationTransportConfig,
} from './transport'
import type { AgentIntegrationDefinition, AgentIntegrationRecord, IntegrationInputResult } from './types'

/**
 * The scope an integration's endpoint is minted and claimed under: its
 * creator's platform member, as for agent-minted webhook endpoints.
 */
export async function integrationRelayScope(userId?: string): Promise<string> {
  const resolved = userId ? await resolvePlatformMemberForCandidates([userId]) : null
  return resolved?.memberId ?? getStoredPlatformMemberId() ?? LOCAL_RELAY_SCOPE
}

/** The endpoint's name on the platform, which lists it alongside agent-minted ones. */
export function integrationRelayName(providerName: string, agentSlug: string): string {
  return `${providerName} integration for ${agentSlug}`
}

/** Mints the public URL an integration's webhooks will arrive at. */
export async function provisionIntegrationRelay(name: string, userId?: string): Promise<IntegrationRelayBinding> {
  const scope = await integrationRelayScope(userId)
  try {
    const endpoint = await getWebhookRelay().createEndpoint(scope, { name: name.slice(0, 200) })
    return integrationRelayBindingSchema.parse({ endpointId: endpoint.id, url: endpoint.url, scope })
  } catch (error) {
    if (error instanceof WebhookRelayUnavailableError) throw new IntegrationSetupError(error.message)
    if (error instanceof WebhookEndpointsApiError && error.statusCode === 409) {
      throw new IntegrationSetupError('This workspace has reached its limit of active webhook endpoints. Remove an unused integration or webhook trigger first.')
    }
    throw error
  }
}

/** The URL stops accepting deliveries. */
export async function disableIntegrationRelay(binding: IntegrationRelayBinding): Promise<void> {
  await getWebhookRelay().disableEndpoint(binding.scope, binding.endpointId)
}

/**
 * An integration is being deleted: nothing more is claimed for it, what was
 * already claimed is discarded, and its URL is disabled. Never throws: a
 * relay that can't be reached must not block deletion.
 */
export async function releaseIntegrationTransport(record: AgentIntegrationRecord): Promise<void> {
  integrationRelays.remove(record.id)
  let relay: IntegrationRelayBinding | undefined
  try {
    relay = readIntegrationTransport(record.config).relay
  } catch {
    return
  }
  if (!relay) return
  try {
    await disableIntegrationRelay(relay)
  } catch (error) {
    // The URL stays live but nothing claims its events; they expire on the platform.
    captureException(error, {
      tags: { component: 'agent-integration', operation: 'disable-relay-endpoint' },
      extra: { integrationId: record.id, provider: record.provider, endpointId: relay.endpointId },
    })
  }
}

/**
 * Moves an existing installation to another transport; `write` stores the new
 * transport fields. A new endpoint is minted before the write and disabled
 * again if the write fails; the old one is disabled only once the write has
 * happened. Returns false when it is already on that transport.
 */
export async function changeIntegrationTransport(
  record: AgentIntegrationRecord,
  definition: Pick<AgentIntegrationDefinition, 'name' | 'transports'>,
  to: IntegrationTransport,
  write: (next: IntegrationTransportConfig) => Promise<void>,
): Promise<boolean> {
  const current = readIntegrationTransport(record.config)
  if (current.transport === to) return false
  if (!supportedTransports(definition).includes(to)) throw new IntegrationSetupError(`${definition.name} can't receive events over the ${to === 'relay' ? 'webhook relay' : 'direct connection'}`)
  if (to === 'relay') {
    const relay = await provisionIntegrationRelay(integrationRelayName(definition.name, record.agentSlug), record.createdByUserId ?? undefined)
    try {
      await write({ transport: 'relay', relay })
    } catch (error) {
      await disableIntegrationRelay(relay).catch((cleanup: unknown) => {
        captureException(cleanup, { tags: { component: 'agent-integration', operation: 'release-relay-endpoint' }, extra: { integrationId: record.id } })
      })
      throw error
    }
    return true
  }
  await write({ transport: 'direct' })
  await releaseIntegrationTransport(record)
  return true
}

/** Every result but `retry` acknowledges the event to the relay. */
export function relayAcceptResult(result: IntegrationInputResult): RelayAcceptResult {
  return result === 'rejected' ? 'discard' : result
}

export type IntegrationRelayAccept = (
  events: readonly RelayEvent[],
) => Promise<RelayAcceptResult | ReadonlyMap<string, RelayAcceptResult>>

export interface IntegrationRelayAttachment {
  /** This connection stops receiving; nothing is claimed until one attaches again. */
  detach(): void
}

interface Registration {
  handle: RelayConsumerHandle
  accept: IntegrationRelayAccept | null
}

/**
 * One relay registration per integration, outliving any one connection. A
 * reconnect attaches the new connection behind the same registration, so
 * events claimed while the old one went away are offered to the new one.
 */
export class IntegrationRelays {
  private readonly registrations = new Map<string, Registration>()

  constructor(private readonly relay: () => WebhookRelayService = getWebhookRelay) {}

  attach(integrationId: string, binding: IntegrationRelayBinding, accept: IntegrationRelayAccept): IntegrationRelayAttachment {
    let registration = this.registrations.get(integrationId)
    if (registration) {
      registration.accept = accept
      registration.handle.update({ scope: binding.scope, endpointIds: [binding.endpointId] })
      // Events that waited out the gap go now, not after their backoff.
      registration.handle.retryNow()
    } else {
      const created: Registration = { handle: null as unknown as RelayConsumerHandle, accept }
      created.handle = this.relay().register({
        id: `integration:${integrationId}`,
        scope: binding.scope,
        endpointIds: [binding.endpointId],
        // Whichever connection is attached; none while it reconnects.
        accept: async (events) => (created.accept ? created.accept(events) : 'retry'),
      })
      this.registrations.set(integrationId, created)
      registration = created
    }
    const attached = registration
    return {
      detach: () => {
        if (this.registrations.get(integrationId) !== attached || attached.accept !== accept) return
        attached.accept = null
        attached.handle.update({ endpointIds: [] })
      },
    }
  }

  isAttached(integrationId: string): boolean {
    return !!this.registrations.get(integrationId)?.accept
  }

  remove(integrationId: string): void {
    const registration = this.registrations.get(integrationId)
    if (!registration) return
    this.registrations.delete(integrationId)
    // Claimed events have no integration left to go to.
    registration.accept = async () => 'discard'
    registration.handle.dispose()
  }
}

// Persists across hot reloads like the relay itself: a fresh copy would hold
// no registrations and collide with the relay's on the next attach.
const globalForIntegrationRelays = globalThis as unknown as { integrationRelays: IntegrationRelays | undefined }
globalForIntegrationRelays.integrationRelays ??= new IntegrationRelays()
export const integrationRelays = globalForIntegrationRelays.integrationRelays
