import { matchesHostPatterns } from '../proxy/allowed-hosts'
import type { WebSearchHit } from './types'

export interface AllowedSitesPolicy {
  allowedSites?: string[] // if non-empty, ONLY hits whose host matches are kept
  blockedSites?: string[] // hits whose host matches are always dropped (wins over allow)
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Host-side enforcement of the operator's allow/deny policy on search hits
 * (the must-enforce overlay, design §8). Patterns use the same exact-or-`*.`
 * matcher as the toolkit allowlist. A block beats an allow; an unparseable host
 * can't be proven safe, so it's dropped whenever a policy is active. Default
 * (both empty) = allow all, returning the original array untouched.
 */
export function applyAllowedSites(
  hits: WebSearchHit[],
  policy: AllowedSitesPolicy,
): { hits: WebSearchHit[]; removed: number } {
  const allowed = policy.allowedSites ?? []
  const blocked = policy.blockedSites ?? []
  if (allowed.length === 0 && blocked.length === 0) {
    return { hits, removed: 0 }
  }

  const kept = hits.filter((h) => {
    const host = hostOf(h.url)
    if (host === null) return false
    if (blocked.length > 0 && matchesHostPatterns(host, blocked)) return false
    if (allowed.length > 0 && !matchesHostPatterns(host, allowed)) return false
    return true
  })

  return { hits: kept, removed: hits.length - kept.length }
}
