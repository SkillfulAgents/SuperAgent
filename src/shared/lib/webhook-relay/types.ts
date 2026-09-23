/**
 * Webhook relay: the host's one inbound path for third-party webhooks.
 *
 * A relay receives webhooks at public URLs ("endpoints") on the host's behalf
 * and queues them until the host claims them. One service per host owns the
 * connection, claiming, acknowledgement and health; features (webhook
 * triggers, agent integrations) register as consumers of their endpoints'
 * events and never talk to the relay themselves.
 */

/**
 * Authorization scope an endpoint's events are claimed under: the platform
 * member that owns the endpoint, or LOCAL_RELAY_SCOPE for an opaque access key
 * (which the platform already binds to one member).
 */
export type RelayScope = string

export const LOCAL_RELAY_SCOPE = 'local'

export interface RelayEvent {
  id: string
  endpointId: string
  type: string
  payload: unknown
  createdAt: string
}

/**
 * What a consumer did with an event. Every result except `retry` acknowledges
 * the event to the relay, so it is never offered again:
 * - accepted: the consumer took it over
 * - duplicate: the consumer had already taken it over
 * - discard: deliberately dropped (e.g. its trigger is paused)
 * - retry: transient failure; the relay keeps it and offers it again later
 */
export type RelayAcceptResult = 'accepted' | 'duplicate' | 'discard' | 'retry'

export interface RelayConsumer {
  /** Stable and unique on this host, e.g. `webhook-triggers:<memberId>`. */
  id: string
  scope: RelayScope
  /** One consumer owns an endpoint within a scope. */
  endpointIds: readonly string[]
  /**
   * Receives claimed events for this consumer's endpoints, oldest first.
   * Returns one result for all of them, or a result per event id (a missing
   * id is a retry). A throw is a retry.
   */
  accept(events: readonly RelayEvent[]): Promise<RelayAcceptResult | ReadonlyMap<string, RelayAcceptResult>>
}

export interface RelayConsumerHandle {
  update(changes: { scope?: RelayScope; endpointIds?: readonly string[] }): void
  /** Stops delivery; events still waiting for this consumer are dropped unacknowledged. */
  dispose(): void
}

export type WebhookRelayUnavailableReason =
  /** This build has no relay to connect to. */
  | 'not_configured'
  | 'platform_disconnected'

/**
 * - idle: nothing is registered, so nothing is fetched
 * - connecting: registered, no claim has completed yet
 * - realtime: claims succeed and the realtime wake-up channel is open
 * - polling: claims succeed, realtime is down, so the relay polls on a timer
 * - unreachable: every claim in the last round failed
 */
export type WebhookRelayTransport = 'idle' | 'connecting' | 'realtime' | 'polling' | 'unreachable'

export interface WebhookRelaySnapshot {
  /** Webhooks can be received: endpoints can be registered and their events are delivered. */
  available: boolean
  unavailableReason: WebhookRelayUnavailableReason | null
  transport: WebhookRelayTransport
  /** Last round in which a claim succeeded. */
  lastClaimAt: string | null
  lastError: string | null
}

export interface WebhookRelayService {
  readonly kind: 'platform' | 'unavailable'
  snapshot(): WebhookRelaySnapshot
  /** Called on availability/transport/error changes, not on every claim. */
  onChange(listener: (snapshot: WebhookRelaySnapshot) => void): () => void
  /** Allowed while unavailable; delivery starts once the relay is. */
  register(consumer: RelayConsumer): RelayConsumerHandle
  /** Claim soon, e.g. right after minting a new endpoint. Coalesced. */
  wake(): void
  start(): void
  stop(): void
  /** Re-read platform auth: go (un)available, and reset the connection when the token changed. */
  onAuthChanged(): void
}
