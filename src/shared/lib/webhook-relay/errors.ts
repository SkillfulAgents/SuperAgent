import type { WebhookRelayUnavailableReason } from './types'

const MESSAGES: Record<WebhookRelayUnavailableReason, string> = {
  not_configured: 'No webhook relay is available on this host',
  stopped: 'The webhook relay is not running',
  platform_disconnected: 'The webhook relay is unavailable: the platform is not connected',
}

export class WebhookRelayUnavailableError extends Error {
  constructor(readonly reason: WebhookRelayUnavailableReason) {
    super(MESSAGES[reason])
    this.name = 'WebhookRelayUnavailableError'
  }
}
