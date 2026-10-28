import type { WebhookFilterTestResult } from '@shared/lib/services/webhook-endpoint-schema'
import { WebhookRelayUnavailableError } from './errors'
import {
  RELAY_PASS_INTERVAL_MS,
  type RelayConsumerHandle,
  type RelayEndpoint,
  type RelayEndpointEvents,
  type WebhookRelayService,
  type WebhookRelaySnapshot,
  type WebhookRelayUnavailableReason,
} from './types'

/**
 * The relay for a host that has none: registrations are kept by their owners
 * and never delivered to, and endpoints can't be minted.
 */
export class UnavailableWebhookRelayService implements WebhookRelayService {
  readonly kind = 'unavailable' as const
  readonly passIntervalMs = RELAY_PASS_INTERVAL_MS

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
  async runPass(): Promise<void> {}
  stop(): void {}
  onAuthChanged(): void {}
}
