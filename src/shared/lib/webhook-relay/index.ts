import { attribution, runOutsideAttribution } from '@shared/lib/platform-attribution'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { SupabaseRealtimeClient } from '@shared/lib/services/supabase-realtime-client'
import {
  createPlatformWebhookEndpoint,
  disablePlatformWebhookEndpoint,
  listPlatformWebhookEvents,
  testPlatformWebhookFilter,
  updatePlatformWebhookEndpoint,
} from './platform-endpoints-client'
import { acknowledgePlatformRelayEvents, claimPlatformRelayEvents } from './platform-relay-client'
import { PlatformWebhookRelayService } from './platform-webhook-relay-service'
import { describeWebhookRelayUnavailable } from './errors'
import type { WebhookRelayService } from './types'
import { UnavailableWebhookRelayService } from './unavailable-webhook-relay-service'

export * from './types'
export { WebhookRelayUnavailableError, describeWebhookRelayUnavailable } from './errors'
export * from './status'

// One relay per host. A build with a platform proxy always gets the platform
// relay, which goes available/unavailable as the platform connects and
// disconnects; other relays (a public URL, a tunnel) would slot in here.
function createWebhookRelay(): WebhookRelayService {
  if (!getPlatformProxyBaseUrl()) return new UnavailableWebhookRelayService('not_configured')
  return new PlatformWebhookRelayService({
    claim: claimPlatformRelayEvents,
    acknowledge: acknowledgePlatformRelayEvents,
    endpoints: {
      create: createPlatformWebhookEndpoint,
      update: updatePlatformWebhookEndpoint,
      disable: disablePlatformWebhookEndpoint,
      listEvents: listPlatformWebhookEvents,
      testFilter: testPlatformWebhookFilter,
    },
    getToken: () => getPlatformAccessToken(),
    requiresMemberScope: () => attribution.requiresActingMember(),
    createRealtime: () => new SupabaseRealtimeClient(),
    detach: runOutsideAttribution,
  })
}

// Persists across hot reloads, like the other host-wide managers.
const globalForRelay = globalThis as unknown as { webhookRelay: WebhookRelayService | undefined }

export function getWebhookRelay(): WebhookRelayService {
  globalForRelay.webhookRelay ??= createWebhookRelay()
  return globalForRelay.webhookRelay
}

/**
 * Why `what` can't be used on this host right now, or null when webhooks can
 * be received. Every "are webhooks available" decision goes through the
 * relay's snapshot, never a platform-token check of its own.
 */
export function webhooksUnavailableMessage(what: string): string | null {
  const { unavailableReason } = getWebhookRelay().snapshot()
  return unavailableReason ? describeWebhookRelayUnavailable(what, unavailableReason) : null
}
