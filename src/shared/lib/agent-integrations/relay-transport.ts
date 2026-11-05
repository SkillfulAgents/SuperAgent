import { and, eq, ne, sql } from 'drizzle-orm'
import { db } from '../db'
import { changesOf } from '../db/batch'
import { chatIntegrations } from '../db/schema'
import { captureException } from '../error-reporting'
import { getStoredPlatformMemberId } from '../services/platform-auth-service'
import { resolvePlatformMemberForCandidates } from '../services/webhook-trigger-service'
import {
  LOCAL_RELAY_SCOPE,
  WebhookRelayUnavailableError,
  getWebhookRelay,
  type RelayAcceptResult,
  type RelayConsumerHandle,
  type RelayEndpoint,
  type RelayEvent,
  type WebhookRelayService,
} from '../webhook-relay'
import { WebhookEndpointsApiError } from '../webhook-relay/platform-endpoints-client'
import type { VerificationProfile } from '../services/webhook-endpoint-schema'
import { IntegrationSetupError } from './setup-types'
import {
  integrationRelayBindingSchema,
  readIntegrationRelay,
  readIntegrationRelayIntent,
  supportedTransports,
  type IntegrationRelayAccept,
  type IntegrationRelayAttachment,
  type IntegrationRelayBinding,
  type IntegrationRelayHost,
  type IntegrationRelayIntent,
} from './transport'
import type { AgentIntegrationDefinition, AgentIntegrationRecord, IntegrationInputResult } from './types'

/**
 * The scope an integration's endpoint is minted and claimed under: its
 * creator's platform member, as for agent-minted webhook endpoints.
 */
export async function integrationRelayScope(userId?: string): Promise<string> {
  const resolved = userId ? await resolvePlatformMemberForCandidates([userId]) : null
  return resolved?.memberId ?? (await getStoredPlatformMemberId()) ?? LOCAL_RELAY_SCOPE
}

/** The endpoint's name on the platform, which lists it alongside agent-minted ones. */
export function integrationRelayName(providerName: string, agentSlug: string): string {
  return `${providerName} integration for ${agentSlug}`
}

/**
 * Mints the public URL an integration's webhooks will arrive at. With a
 * verification profile, the relay rejects deliveries that don't match it.
 */
export async function provisionIntegrationRelay(name: string, userId?: string, verification?: VerificationProfile): Promise<IntegrationRelayBinding> {
  const scope = await integrationRelayScope(userId)
  return mintedRelay(scope, () => getWebhookRelay().createEndpoint(scope, { name: name.slice(0, 200), ...(verification ? { verification } : {}) }))
}

async function mintedRelay(scope: string, mint: () => Promise<RelayEndpoint>): Promise<IntegrationRelayBinding> {
  try {
    return relayBindingOf(await mint(), scope)
  } catch (error) {
    if (error instanceof WebhookRelayUnavailableError) throw new IntegrationSetupError(error.message)
    if (error instanceof WebhookEndpointsApiError && error.statusCode === 409) {
      throw new IntegrationSetupError('This workspace has reached its limit of active webhook endpoints. Remove an unused integration or webhook trigger first.')
    }
    throw error
  }
}

export function relayBindingOf(endpoint: RelayEndpoint, scope: string): IntegrationRelayBinding {
  return integrationRelayBindingSchema.parse({ endpointId: endpoint.id, url: endpoint.url, scope })
}

/**
 * The deadline on each request about an intent's endpoint. Chosen here: the
 * platform's endpoint routes had none. Past it the request is cancelled, and it
 * may still have taken effect. A lease held across these requests takes its TTL
 * from this.
 */
export const RELAY_INTENT_REQUEST_TIMEOUT_MS = 20_000
const INTENT_REQUEST = { timeoutMs: RELAY_INTENT_REQUEST_TIMEOUT_MS }

/**
 * Mints an intent's endpoint. Nothing here is awaited before the relay is
 * called, so a lease holder can confirm its lease right before this. A failure,
 * including a timeout, says nothing about whether the endpoint exists: the
 * intent stays and the next attempt looks for it.
 */
export function mintIntentRelayEndpoint(intent: IntegrationRelayIntent, verification?: VerificationProfile): Promise<IntegrationRelayBinding> {
  return mintedRelay(intent.scope, () => getWebhookRelay().createEndpoint(
    intent.scope,
    { name: intent.endpointName, ...(verification ? { verification } : {}) },
    INTENT_REQUEST,
  ))
}

/** The live endpoints minted for an intent, oldest first: usually none or one, more if a lost mint landed late. */
export async function findIntentRelayEndpoints(intent: IntegrationRelayIntent): Promise<RelayEndpoint[]> {
  try {
    const endpoints = await getWebhookRelay().listEndpoints(intent.scope, INTENT_REQUEST)
    return endpoints
      .filter(endpoint => endpoint.name === intent.endpointName && endpoint.status === 'active')
      .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id))
  } catch (error) {
    if (error instanceof WebhookRelayUnavailableError) throw new IntegrationSetupError(error.message)
    throw error
  }
}

/** Disables each endpoint no installation stores. Throws on the first that can't be disabled. */
export async function disableUnusedRelayEndpoints(scope: string, endpointIds: readonly string[]): Promise<void> {
  for (const endpointId of endpointIds) {
    if (await relayEndpointInUse(endpointId)) continue
    await getWebhookRelay().disableEndpoint(scope, endpointId, INTENT_REQUEST)
  }
}

/** Disables whatever was minted for an intent and nothing uses. Throws if that can't be done or can't be told. */
export async function disableIntentRelayEndpoints(intent: IntegrationRelayIntent): Promise<void> {
  const endpoints = await findIntentRelayEndpoints(intent)
  await disableUnusedRelayEndpoints(intent.scope, endpoints.map(endpoint => endpoint.id))
}

/** Forgets an intent, if the installation still has this one. Once it's gone, the attempt's attach is refused. */
export async function clearIntegrationRelayIntent(integrationId: string, attemptId: string): Promise<boolean> {
  const result = await db.update(chatIntegrations)
    .set({ config: sql`json_remove(${chatIntegrations.config}, '$.relayProvisioning')`, updatedAt: new Date() })
    .where(and(eq(chatIntegrations.id, integrationId), sql`json_extract(${chatIntegrations.config}, '$.relayProvisioning.attemptId') = ${attemptId}`))
    .run()
  return changesOf(result) > 0
}

/** The URL stops accepting deliveries. */
export async function disableIntegrationRelay(binding: IntegrationRelayBinding): Promise<void> {
  await getWebhookRelay().disableEndpoint(binding.scope, binding.endpointId)
}

/** An installation, other than `exceptIntegrationId`, receives through this endpoint (Email's mailboxes share one per scope). */
async function relayEndpointInUse(endpointId: string, exceptIntegrationId?: string): Promise<boolean> {
  const other = await db.select({ id: chatIntegrations.id }).from(chatIntegrations)
    .where(and(exceptIntegrationId ? ne(chatIntegrations.id, exceptIntegrationId) : undefined, sql`json_extract(${chatIntegrations.config}, '$.relay.endpointId') = ${endpointId}`)).get()
  return !!other
}

async function storedConfig(integrationId: string): Promise<string | undefined> {
  const row = await db.select({ config: chatIntegrations.config }).from(chatIntegrations).where(eq(chatIntegrations.id, integrationId)).get()
  return row?.config
}

/**
 * An endpoint was being provisioned for an installation that is going away. The
 * intent is forgotten first, so no attempt can attach its endpoint while it is
 * being taken down; an attempt still running disables what it minted when its
 * attach is refused. If the attach got there first, the endpoint is an ordinary
 * one, for the caller to release. Never throws. If the platform can't be
 * reached, the endpoint stays live under its attempt's name, and is reported.
 */
async function releaseRelayIntent(record: AgentIntegrationRecord): Promise<void> {
  try {
    const stored = await storedConfig(record.id)
    const intent = readIntegrationRelayIntent(stored ?? record.config)
    if (!intent) return
    if (stored !== undefined && !(await clearIntegrationRelayIntent(record.id, intent.attemptId))) return
    await disableIntentRelayEndpoints(intent)
  } catch (error) {
    captureException(error, {
      tags: { component: 'agent-integration', operation: 'release-relay-intent' },
      extra: { integrationId: record.id, provider: record.provider },
    })
  }
}

/**
 * An integration is being deleted: nothing more is claimed for it, what was
 * already claimed is discarded, and its URL is disabled unless another
 * installation still uses it. Never throws: a relay that can't be reached
 * must not block deletion.
 */
export async function releaseIntegrationTransport(record: AgentIntegrationRecord): Promise<void> {
  integrationRelays.remove(record.id)
  await releaseRelayIntent(record)
  let relay: IntegrationRelayBinding | undefined
  try {
    // The stored row too: an attempt may have attached since this record was read.
    const stored = readIntegrationRelay(record.config) ? undefined : await storedConfig(record.id)
    relay = readIntegrationRelay(stored ?? record.config)
  } catch {
    return
  }
  if (!relay) return
  try {
    if (await relayEndpointInUse(relay.endpointId, record.id)) return
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
 * Sets up webhooks for an existing installation: mints its endpoint, then
 * `write` stores it. The endpoint is disabled again if the write fails.
 * Returns false if they are already set up.
 */
export async function setUpIntegrationWebhooks(
  record: AgentIntegrationRecord,
  definition: Pick<AgentIntegrationDefinition, 'name' | 'transports'>,
  write: (relay: IntegrationRelayBinding) => Promise<void>,
  verification?: VerificationProfile,
): Promise<boolean> {
  if (readIntegrationRelay(record.config)) return false
  if (!supportedTransports(definition).includes('relay')) throw new IntegrationSetupError(`${definition.name} can't receive webhooks`)
  const relay = await provisionIntegrationRelay(integrationRelayName(definition.name, record.agentSlug), record.createdByUserId ?? undefined, verification)
  try {
    await write(relay)
  } catch (error) {
    await disableIntegrationRelay(relay).catch((cleanup: unknown) => {
      captureException(cleanup, { tags: { component: 'agent-integration', operation: 'release-relay-endpoint' }, extra: { integrationId: record.id } })
    })
    throw error
  }
  return true
}

/**
 * Removes an installation's webhooks: `write` forgets the endpoint, then it is
 * disabled. Deliveries already claimed for it are dropped. Returns false if
 * there were none.
 */
export async function removeIntegrationWebhooks(record: AgentIntegrationRecord, write: () => Promise<void>): Promise<boolean> {
  if (!readIntegrationRelay(record.config)) return false
  await write()
  await releaseIntegrationTransport(record)
  return true
}

/** Every result but `retry` acknowledges the event to the relay. */
export function relayAcceptResult(result: IntegrationInputResult): RelayAcceptResult {
  return result === 'rejected' ? 'discard' : result
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
    const current = () => this.registrations.get(integrationId) === attached && attached.accept === accept
    return {
      detach: () => {
        if (!current()) return
        attached.accept = null
        attached.handle.update({ endpointIds: [] })
      },
      isAttached: current,
    }
  }

  /**
   * The relay to hand one connection of this integration: present while the
   * host's relay is available as the connection starts, null otherwise.
   */
  hostFor(integrationId: string): IntegrationRelayHost | null {
    if (!this.relay().snapshot().available) return null
    return { attach: (binding, accept) => this.attach(integrationId, binding, accept) }
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
