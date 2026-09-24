import type { WebhookRelayService, WebhookRelaySnapshot } from './types'

/**
 * What the API and the notification stream publish about the relay. Leaves
 * out `lastError`, which can carry platform response text and goes to every
 * signed-in user; the server logs it instead.
 */
export type WebhookRelayStatus = Omit<WebhookRelaySnapshot, 'lastError'>

export const WEBHOOK_RELAY_CHANGED_EVENT = 'webhook_relay_changed'

export function toWebhookRelayStatus(snapshot: WebhookRelaySnapshot): WebhookRelayStatus {
  return {
    available: snapshot.available,
    unavailableReason: snapshot.unavailableReason,
    transport: snapshot.transport,
    lastClaimAt: snapshot.lastClaimAt,
  }
}

export interface WebhookRelayWatchers {
  broadcast(status: WebhookRelayStatus): void
  /** Running agents whose env was built with the other availability go stale. */
  reconcileAgents(available: boolean): void
}

/** Publishes every status change, and keeps running agents' webhook tools honest. */
export function watchWebhookRelay(relay: WebhookRelayService, watchers: WebhookRelayWatchers): () => void {
  // Changes before this went unobserved: publish where things stand, and
  // catch agents started before the relay was (their env said unavailable).
  const current = relay.snapshot()
  watchers.broadcast(toWebhookRelayStatus(current))
  watchers.reconcileAgents(current.available)
  return relay.onChange((snapshot) => {
    watchers.broadcast(toWebhookRelayStatus(snapshot))
    watchers.reconcileAgents(snapshot.available)
  })
}
