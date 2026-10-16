import type { WebhookRelayUnavailableReason } from './types'

const REASONS: Record<WebhookRelayUnavailableReason, string> = {
  not_configured: 'this host has no webhook relay',
  stopped: 'the webhook relay is not running',
  platform_disconnected: 'the platform is not connected',
}

/** "<what> are unavailable: <why>", for tool results and errors. */
export function describeWebhookRelayUnavailable(what: string, reason: WebhookRelayUnavailableReason): string {
  return `${what} are unavailable: ${REASONS[reason]}`
}

export class WebhookRelayUnavailableError extends Error {
  constructor(readonly reason: WebhookRelayUnavailableReason) {
    super(describeWebhookRelayUnavailable('Webhooks', reason))
    this.name = 'WebhookRelayUnavailableError'
  }
}
