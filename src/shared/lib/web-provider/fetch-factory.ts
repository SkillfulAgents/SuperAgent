import { getSettings } from '../config/settings'
import type { BaseWebFetchProvider } from './base-web-fetch-provider'
import { ExaWebFetchProvider } from './exa-web-fetch-provider'
import type { WebFetchProviderId } from './types'

// Every non-native vendor id maps to its provider. A Record (not a Map) so adding a vendor to the
// union without wiring it here is a COMPILE error — the same compile-time exhaustiveness the search
// registry (and LlmProvider / SttProvider) rely on. 'native' is the no-host-provider sentinel and
// is intentionally absent. Constructors take no key (resolved per call), so eager construction is
// safe.
type WebFetchVendorId = Exclude<WebFetchProviderId, 'native'>

const WEB_FETCH_PROVIDERS: Record<WebFetchVendorId, BaseWebFetchProvider> = {
  exa: new ExaWebFetchProvider(),
}

/** Runtime narrow (not a cast) of an arbitrary id string to a registered vendor id. */
function isVendorId(id: string): id is WebFetchVendorId {
  return id !== 'native' && id in WEB_FETCH_PROVIDERS
}

/** The provider for a known vendor id. */
export function getWebFetchProvider(id: WebFetchVendorId): BaseWebFetchProvider {
  return WEB_FETCH_PROVIDERS[id]
}

/**
 * Look up a provider by an untrusted id string (e.g. a request body field); null for a miss.
 * Narrows on a runtime check rather than casting.
 */
export function findWebFetchProvider(id: string): BaseWebFetchProvider | null {
  return isVendorId(id) ? WEB_FETCH_PROVIDERS[id] : null
}

/**
 * The active host-side fetch provider, or null when native is selected, nothing is configured, or
 * the configured id isn't a known vendor — native (no host provider) is the fallback in each case.
 */
export function getActiveWebFetchProvider(): BaseWebFetchProvider | null {
  const id = getSettings().webFetchProvider ?? 'native'
  return isVendorId(id) ? WEB_FETCH_PROVIDERS[id] : null
}
