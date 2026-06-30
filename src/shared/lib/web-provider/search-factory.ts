import { getSettings } from '../config/settings'
import type { BaseWebSearchProvider } from './base-web-search-provider'
import { ExaWebSearchProvider } from './exa-web-search-provider'
import { FirecrawlWebSearchProvider } from './firecrawl-web-search-provider'
import { ParallelWebSearchProvider } from './parallel-web-search-provider'
import { YouComWebSearchProvider } from './youcom-web-search-provider'
import type { WebSearchProviderId } from './types'

// Every non-native vendor id maps to its provider. A Record (not a Map) so adding a vendor to the
// union without wiring it here is a COMPILE error — the same compile-time exhaustiveness the
// LlmProvider / SttProvider registries rely on. 'native' is the no-host-provider sentinel and is
// intentionally absent. Constructors take no key (resolved per call), so eager construction is safe.
type WebSearchVendorId = Exclude<WebSearchProviderId, 'native'>

const WEB_SEARCH_PROVIDERS: Record<WebSearchVendorId, BaseWebSearchProvider> = {
  exa: new ExaWebSearchProvider(),
  parallel: new ParallelWebSearchProvider(),
  youcom: new YouComWebSearchProvider(),
  firecrawl: new FirecrawlWebSearchProvider(),
}

/** Runtime narrow (not a cast) of an arbitrary id string to a registered vendor id. */
function isVendorId(id: string): id is WebSearchVendorId {
  return id !== 'native' && id in WEB_SEARCH_PROVIDERS
}

/** The provider for a known vendor id. */
export function getWebSearchProvider(id: WebSearchVendorId): BaseWebSearchProvider {
  return WEB_SEARCH_PROVIDERS[id]
}

/**
 * Look up a provider by an untrusted id string (e.g. a request body field); null for a miss.
 * Narrows on a runtime check rather than casting.
 */
export function findWebSearchProvider(id: string): BaseWebSearchProvider | null {
  return isVendorId(id) ? WEB_SEARCH_PROVIDERS[id] : null
}

/**
 * The active host-side search provider, or null when native is selected, nothing is configured, or
 * the configured id isn't a known vendor — native (no host provider) is the fallback in each case.
 */
export function getActiveWebSearchProvider(): BaseWebSearchProvider | null {
  const id = getSettings().webSearchProvider ?? 'native'
  return isVendorId(id) ? WEB_SEARCH_PROVIDERS[id] : null
}
