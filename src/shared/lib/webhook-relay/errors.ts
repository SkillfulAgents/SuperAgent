import type { WebhookRelayUnavailableReason } from './types'

export class WebhookRelayUnavailableError extends Error {
  constructor(readonly reason: WebhookRelayUnavailableReason) {
    super(
      reason === 'not_configured'
        ? 'No webhook relay is available on this host'
        : 'The webhook relay is unavailable: the platform is not connected',
    )
    this.name = 'WebhookRelayUnavailableError'
  }
}
