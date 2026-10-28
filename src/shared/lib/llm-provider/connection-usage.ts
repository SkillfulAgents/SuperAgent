import { providerForConnection, type ConnectionRow } from './connections'
import { isOAuthProvider } from './provider-types'
import { providerUsageSchema, usageSnapshot, type ProviderUsage } from './usage-schema'

// Access is checked by the route before consulting this process-local cache.
// Subscription allowances are account-wide, so members share the same read.
// Platform stays uncached: its seat balance depends on current attribution.
const cache = new Map<string, { expiresAt: number; result: Promise<ProviderUsage> }>()
const lastWarning = new Map<string, number>()
const TTL = 60_000

export function readConnectionUsage(row: Pick<ConnectionRow, 'id' | 'provider' | 'config' | 'generation'>): Promise<ProviderUsage> {
  const shared = isOAuthProvider(row.provider)
  const key = JSON.stringify([row.id, row.provider, row.generation])
  const now = Date.now()
  for (const [id, entry] of cache) if (entry.expiresAt <= now) cache.delete(id)
  const cached = shared ? cache.get(key) : undefined
  if (cached) return cached.result

  const result = (async () => {
    try {
      return providerUsageSchema.parse(await providerForConnection(row).getUsage())
    } catch {
      // Log no raw upstream bodies, credential values, or account identifiers.
      // At most one diagnostic per provider type per minute, including Platform.
      if (now - (lastWarning.get(row.provider) ?? -Infinity) >= TTL) {
        console.warn(`[ProviderUsage] ${row.provider}: allowance read unavailable`)
        lastWarning.set(row.provider, now)
      }
      return usageSnapshot([])
    }
  })()
  if (shared) {
    if (cache.size >= 256) cache.delete(cache.keys().next().value!)
    cache.set(key, { expiresAt: now + TTL, result })
  }
  return result
}
