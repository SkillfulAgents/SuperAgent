import type {
  RelayConsumerHandle,
  WebhookRelayService,
  WebhookRelaySnapshot,
  WebhookRelayUnavailableReason,
} from './types'

/** The relay for a host that has none: registrations are kept by their owners and never delivered to. */
export class UnavailableWebhookRelayService implements WebhookRelayService {
  readonly kind = 'unavailable' as const

  constructor(private readonly reason: WebhookRelayUnavailableReason) {}

  snapshot(): WebhookRelaySnapshot {
    return { available: false, unavailableReason: this.reason, transport: 'idle', lastClaimAt: null, lastError: null }
  }

  onChange(): () => void {
    return () => {}
  }

  register(): RelayConsumerHandle {
    return { update: () => {}, dispose: () => {} }
  }

  wake(): void {}
  start(): void {}
  stop(): void {}
  onAuthChanged(): void {}
}
