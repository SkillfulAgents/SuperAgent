import { matchesHostPatterns } from '../proxy/allowed-hosts'
import type { WebSearchHit } from './types'

export interface AllowedSitesPolicy {
  allowedSites?: string[] // if non-empty, ONLY hits whose host matches are kept
  blockedSites?: string[] // hits whose host matches are always dropped (wins over allow)
}

// Canonicalize a host OR a policy pattern to one comparable form: lowercase + no FQDN trailing dot.
// matchesHostPatterns does an exact/`*.`-suffix compare with no normalization of its own, so the URL
// host and the operator's patterns must be normalized IDENTICALLY here — otherwise a trailing dot or
// case difference on EITHER side (host or pattern) becomes a policy bypass. (IDN/punycode canonical-
// ization is not done here: the URL parser yields punycode hosts, so a raw-Unicode pattern entry
// won't match — an accepted limitation shared with the toolkit allowlist's matcher.)
function normalizeHost(h: string): string {
  return h.toLowerCase().replace(/\.+$/, '')
}

function normalizePatterns(patterns: string[]): string[] {
  return patterns.map(normalizeHost)
}

function hostOf(url: string): string | null {
  try {
    // An empty authority (e.g. file:///x) can't be proven safe, so it's treated as unparseable.
    const host = normalizeHost(new URL(url).hostname)
    return host === '' ? null : host
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

  const blockedPatterns = normalizePatterns(blocked)
  const allowedPatterns = normalizePatterns(allowed)
  const kept = hits.filter((h) => {
    const host = hostOf(h.url)
    if (host === null) return false
    if (blockedPatterns.length > 0 && matchesHostPatterns(host, blockedPatterns)) return false
    if (allowedPatterns.length > 0 && !matchesHostPatterns(host, allowedPatterns)) return false
    return true
  })

  return { hits: kept, removed: hits.length - kept.length }
}

/**
 * Single-URL variant of the same policy, for the fetch path: is this target URL's host allowed?
 * Same rules as applyAllowedSites — a block beats an allow, an unparseable host can't be proven
 * safe (rejected whenever a policy is active), and no policy (both empty) allows everything. The
 * fetch route calls this on the target host BEFORE dispatching to the vendor.
 */
export function isUrlAllowed(url: string, policy: AllowedSitesPolicy): boolean {
  const allowed = policy.allowedSites ?? []
  const blocked = policy.blockedSites ?? []
  if (allowed.length === 0 && blocked.length === 0) return true

  const host = hostOf(url)
  if (host === null) return false
  if (blocked.length > 0 && matchesHostPatterns(host, normalizePatterns(blocked))) return false
  if (allowed.length > 0 && !matchesHostPatterns(host, normalizePatterns(allowed))) return false
  return true
}
