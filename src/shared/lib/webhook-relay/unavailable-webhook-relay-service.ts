import type { WebhookFilterTestResult } from '@shared/lib/services/webhook-endpoint-schema'
import { WebhookRelayUnavailableError } from './errors'
import type {
  RelayConsumerHandle,
  RelayEndpoint,
  RelayEndpointEvents,
  WebhookRelayService,
  WebhookRelaySnapshot,
  WebhookRelayUnavailableReason,
} from './types'

/**
 * The relay for a host that has none: registrations are kept by their owners
 * and never delivered to, and endpoints can't be minted.
 */
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
    return { update: () => {}, retryNow: () => {}, dispose: () => {} }
  }

  async createEndpoint(): Promise<RelayEndpoint> {
    throw new WebhookRelayUnavailableError(this.reason)
  }

  async updateEndpoint(): Promise<RelayEndpoint> {
    throw new WebhookRelayUnavailableError(this.reason)
  }

  async disableEndpoint(): Promise<void> {
    throw new WebhookRelayUnavailableError(this.reason)
  }

  async listEndpointEvents(): Promise<RelayEndpointEvents> {
    throw new WebhookRelayUnavailableError(this.reason)
  }

  async testEndpointFilter(): Promise<WebhookFilterTestResult> {
    throw new WebhookRelayUnavailableError(this.reason)
  }

  wake(): void {}
  start(): void {}
  stop(): void {}
  onAuthChanged(): void {}
}
