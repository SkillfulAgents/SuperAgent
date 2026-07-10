import { getSettings } from '../config/settings'
import type { BaseWebProvider } from './base-web-provider'
import { ExaWebProvider } from './exa-web-provider'
import type { WebProviderId } from './types'

// Every non-native vendor id maps to its one provider (both search + fetch). A Record (not a Map)
// so adding a vendor to the union without wiring it here is a COMPILE error — the same compile-time
// exhaustiveness the LlmProvider / SttProvider registries rely on. 'native' is the no-host-provider
// sentinel and is intentionally absent. Constructors take no key (resolved per call), so eager
// construction is safe.
type WebVendorId = Exclude<WebProviderId, 'native'>

const WEB_PROVIDERS: Record<WebVendorId, BaseWebProvider> = {
  exa: new ExaWebProvider(),
}

/** Runtime narrow (not a cast) of an arbitrary id string to a registered vendor id. */
function isVendorId(id: string): id is WebVendorId {
  return id !== 'native' && id in WEB_PROVIDERS
}

/** The provider for a known vendor id. */
export function getWebProvider(id: WebVendorId): BaseWebProvider {
  return WEB_PROVIDERS[id]
}

/**
 * Look up a provider by an untrusted id string (e.g. a request body field); null for a miss.
 * Narrows on a runtime check rather than casting.
 */
export function findWebProvider(id: string): BaseWebProvider | null {
  return isVendorId(id) ? WEB_PROVIDERS[id] : null
}

/**
 * The active host-side web provider, or null when native is selected, nothing is configured, or the
 * configured id isn't a known vendor — native (no host provider) is the fallback in each case. Which
 * operations it backs is a per-tool question answered by the provider's optional search()/fetch()
 * methods, not by a separate registry: callers probe `provider.search` / `provider.fetch`.
 */
export function getActiveWebProvider(): BaseWebProvider | null {
  const id = getSettings().webProvider ?? 'native'
  return isVendorId(id) ? WEB_PROVIDERS[id] : null
}
