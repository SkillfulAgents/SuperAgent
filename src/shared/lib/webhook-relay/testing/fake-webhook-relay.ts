import type {
  RelayAcceptResult,
  RelayConsumer,
  RelayConsumerHandle,
  RelayEvent,
  WebhookRelayService,
  WebhookRelaySnapshot,
} from '../types'

/**
 * A relay for consumer tests: records registrations and delivers events
 * straight to a consumer. Endpoint provisioning isn't faked; mock those calls
 * where a test needs them.
 */
export interface FakeWebhookRelay extends WebhookRelayService {
  /** Live registrations by consumer id, with their latest scope and endpoints. */
  readonly consumers: Map<string, RelayConsumer>
  readonly log: Array<{ op: 'register' | 'update' | 'retryNow' | 'dispose'; id: string }>
  /** Hands events to a consumer as a claim would, with its result per event id. */
  deliver(consumerId: string, events: readonly RelayEvent[]): Promise<Map<string, RelayAcceptResult>>
  /** Replaces the snapshot and tells onChange listeners, as a status change would. */
  setSnapshot(next: WebhookRelaySnapshot): void
  reset(): void
}

const AVAILABLE: WebhookRelaySnapshot = {
  available: true,
  unavailableReason: null,
  transport: 'realtime',
  lastClaimAt: null,
  lastError: null,
}

export function createFakeWebhookRelay(): FakeWebhookRelay {
  const consumers = new Map<string, RelayConsumer>()
  const log: FakeWebhookRelay['log'] = []
  const listeners = new Set<(snapshot: WebhookRelaySnapshot) => void>()
  let snapshot = AVAILABLE

  return {
    kind: 'platform',
    consumers,
    log,
    snapshot: () => snapshot,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setSnapshot(next) {
      snapshot = next
      for (const listener of listeners) listener(next)
    },
    register(consumer): RelayConsumerHandle {
      if (consumers.has(consumer.id)) throw new Error(`consumer ${consumer.id} already registered`)
      let current: RelayConsumer = { ...consumer, endpointIds: [...consumer.endpointIds] }
      consumers.set(consumer.id, current)
      log.push({ op: 'register', id: consumer.id })
      let disposed = false
      return {
        update(changes) {
          if (disposed) return
          current = {
            ...current,
            scope: changes.scope ?? current.scope,
            endpointIds: changes.endpointIds ? [...changes.endpointIds] : current.endpointIds,
          }
          consumers.set(consumer.id, current)
          log.push({ op: 'update', id: consumer.id })
        },
        retryNow() {
          if (!disposed) log.push({ op: 'retryNow', id: consumer.id })
        },
        dispose() {
          if (disposed) return
          disposed = true
          consumers.delete(consumer.id)
          log.push({ op: 'dispose', id: consumer.id })
        },
      }
    },
    async deliver(consumerId, events) {
      const consumer = consumers.get(consumerId)
      if (!consumer) throw new Error(`no consumer ${consumerId}`)
      const outcome = await consumer.accept(events)
      return new Map(events.map((event) => [
        event.id,
        typeof outcome === 'string' ? outcome : (outcome.get(event.id) ?? 'retry'),
      ]))
    },
    reset() {
      consumers.clear()
      log.length = 0
      listeners.clear()
      snapshot = AVAILABLE
    },
    createEndpoint: () => Promise.reject(new Error('createEndpoint is not faked')),
    updateEndpoint: () => Promise.reject(new Error('updateEndpoint is not faked')),
    disableEndpoint: () => Promise.reject(new Error('disableEndpoint is not faked')),
    listEndpointEvents: () => Promise.reject(new Error('listEndpointEvents is not faked')),
    testEndpointFilter: () => Promise.reject(new Error('testEndpointFilter is not faked')),
    wake: () => {},
    start: () => {},
    stop: () => {},
    onAuthChanged: () => {},
  }
}
