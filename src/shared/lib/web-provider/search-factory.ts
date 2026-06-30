import { getSettings } from '../config/settings'
import type { BaseWebSearchProvider } from './base-web-search-provider'
import type { WebSearchProviderId } from './types'

// Lazy Map registry (mirrors account-providers/provider-factory.ts) so a vendor whose key
// is absent is never constructed. 'native' is a sentinel with no host provider, so it never
// lives in the Map. Adding a vendor = one register line in register.ts + one union entry.
const providers = new Map<WebSearchProviderId, BaseWebSearchProvider>()

export function registerWebSearchProvider(provider: BaseWebSearchProvider): void {
  providers.set(provider.id, provider)
}

export function getWebSearchProvider(id: WebSearchProviderId): BaseWebSearchProvider {
  const p = providers.get(id)
  if (!p) throw new Error(`Web search provider "${id}" is not registered`)
  return p
}

/**
 * Look up a provider by an untrusted id string (e.g. a request body field), returning null for a
 * miss. The Map-key coercion lives here — the registry owns the union — so callers narrow on the
 * null check rather than casting an arbitrary string to WebSearchProviderId.
 */
export function findWebSearchProvider(id: string): BaseWebSearchProvider | null {
  return providers.get(id as WebSearchProviderId) ?? null
}

/** Reset the registry. Used when re-running registration and in tests. */
export function clearWebSearchProviders(): void {
  providers.clear()
}

/**
 * The active host-side search provider, or null when native is selected, nothing is
 * configured, or the configured vendor isn't registered — native (no host provider) is
 * the fallback in every one of those cases.
 */
export function getActiveWebSearchProvider(): BaseWebSearchProvider | null {
  const id = getSettings().webSearchProvider ?? 'native'
  if (id === 'native') return null
  return providers.get(id) ?? null
}
