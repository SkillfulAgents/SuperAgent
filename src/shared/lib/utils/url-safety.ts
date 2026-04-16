/**
 * URL safety helpers — defense against SSRF and scheme confusion when we
 * follow URLs returned by remote services (e.g. the platform proxy giving
 * us a git clone URL).
 *
 * Exposed helpers:
 *   - validateHttpUrl(url): shape check (parseable, http/https only)
 *   - isPrivateHost(hostname): true for loopback/private/link-local IPs
 *     and the `.local` / `localhost` name families
 *   - validateSafeCloneUrl(url, { allowedHostPrefixes? }): full SSRF guard
 */

const PRIVATE_HOSTNAMES = new Set([
  'localhost',
  '0.0.0.0',
  'ip6-localhost',
  'ip6-loopback',
])

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const octets = m.slice(1, 5).map((n) => Number(n))
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false
  const [a, b] = octets
  if (a === 10) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 169 && b === 254) return true // link-local
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

function isPrivateIPv6(host: string): boolean {
  // Strip brackets if present
  const h = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (h === '::1' || h === '::') return true
  if (h.startsWith('fc') || h.startsWith('fd')) return true // ULA fc00::/7
  if (h.startsWith('fe80')) return true // link-local
  // IPv4-mapped — check embedded IPv4
  const v4 = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4) return isPrivateIPv4(v4[1])
  return false
}

export function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  if (PRIVATE_HOSTNAMES.has(lower)) return true
  if (lower.endsWith('.localhost')) return true
  if (lower.endsWith('.local')) return true
  if (isPrivateIPv4(lower)) return true
  if (isPrivateIPv6(lower)) return true
  return false
}

export function validateHttpUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsafe URL protocol: ${parsed.protocol}`)
  }
  return parsed
}

export interface SafeCloneUrlOptions {
  /**
   * If provided, the URL's origin (scheme://host[:port]) must start with one
   * of these prefixes. Use it to constrain clone URLs to the known platform
   * proxy host.
   */
  allowedHostPrefixes?: string[]
}

/**
 * Full clone-URL safety check.
 *
 * Rejects if:
 *  - URL is unparseable
 *  - scheme is not http/https
 *  - host resolves to a private/loopback/link-local address
 *  - allowedHostPrefixes was provided and the URL origin doesn't match any
 *
 * Returns the parsed URL on success.
 */
export function validateSafeCloneUrl(
  url: string,
  options?: SafeCloneUrlOptions,
): URL {
  const parsed = validateHttpUrl(url)
  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`Unsafe clone URL host: ${parsed.hostname}`)
  }
  const prefixes = options?.allowedHostPrefixes
  if (prefixes && prefixes.length > 0) {
    const origin = `${parsed.protocol}//${parsed.host}`
    if (!prefixes.some((p) => origin.startsWith(p))) {
      throw new Error(`Clone URL not on an allowed host: ${origin}`)
    }
  }
  return parsed
}
