/**
 * Whether the host can receive webhooks, which every webhook tool needs. A
 * host older than its webhook relay never sets WEBHOOK_RELAY_AVAILABLE; its
 * PLATFORM_AUTH_ACTIVE meant the same thing then.
 */
export function webhookRelayAvailable(): boolean {
  const relay = process.env.WEBHOOK_RELAY_AVAILABLE
  return relay === undefined ? process.env.PLATFORM_AUTH_ACTIVE === 'true' : relay === 'true'
}
