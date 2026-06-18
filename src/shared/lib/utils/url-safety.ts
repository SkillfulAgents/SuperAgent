/**
 * URL safety helpers — defense against SSRF and scheme confusion when we
 * follow URLs returned by remote services (e.g. the platform proxy giving
 * us a git clone URL).
 *
 * Exposed helpers:
 *   - validateHttpUrl(url): shape check (parseable, http/https only)
 *   - tryParseUrl(input, base?): parse to URL or null (no throw)
 *   - isPrivateHost(hostname): true for loopback/private/link-local IPs
 *     and the `.local` / `localhost` name families
 *   - isHostOrSubdomain(hostname, domain): exact-or-subdomain host match
 *   - validateSafeCloneUrl(url, { allowedHostPrefixes? }): full SSRF guard
 *   - validateMcpDiscoveryUrl(url): SSRF guard for remote-MCP / OAuth discovery
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

export function isLocalhostHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true
  if (lower === 'ip6-localhost' || lower === 'ip6-loopback') return true
  if (lower === '0.0.0.0') return true
  const stripped = lower.replace(/^\[/, '').replace(/\]$/, '')
  if (stripped === '::1') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) return true
  const v4mapped = stripped.match(/::ffff:(127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4mapped) return true
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

/**
 * True iff `hostname` is exactly `domain` or a subdomain of it (case-insensitive).
 * Use it for redirect/host allowlists where a sibling that merely shares the
 * suffix string must NOT match: `isHostOrSubdomain('files.slack.com', 'slack.com')`
 * is true, but `'evilslack.com'` and `'slack.com.evil.com'` are false.
 */
export function isHostOrSubdomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase()
  const d = domain.toLowerCase()
  return host === d || host.endsWith('.' + d)
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

/**
 * Parse `input` (optionally against `base`, for relative redirect locations)
 * into a URL, returning `null` instead of throwing on a malformed value. Lets
 * callers branch on validity without a local try/catch at each call site.
 */
export function tryParseUrl(input: string, base?: string | URL): URL | null {
  try {
    return new URL(input, base)
  } catch {
    return null
  }
}

/**
 * SSRF host policy for remote-MCP server and OAuth-discovery URLs.
 *
 * Runs validateHttpUrl + isPrivateHost, with a localhost exception that is
 * allowed only inside Electron (`process.type === 'browser'`) or under the
 * E2E mock — users may legitimately run an MCP server on localhost there, but
 * other private/loopback addresses are always rejected.
 *
 * This is the single source of truth shared by the remote-MCP entry guard
 * (validateMcpServerUrl) AND the OAuth metadata discovery path
 * (discoverOAuthMetadata), so the two cannot drift: every server-supplied
 * metadata URL the discovery flow follows is held to the same policy.
 *
 * Returns the parsed URL on success; throws on rejection so callers can fail
 * closed without ever issuing the fetch.
 */
export function validateMcpDiscoveryUrl(url: string): URL {
  const parsed = validateHttpUrl(url)
  if (isPrivateHost(parsed.hostname)) {
    // In Electron (or under the E2E mock) allow localhost MCP servers since
    // users may be running them locally, but still block other private hosts.
    const isElectron = process.type === 'browser'
    if ((isElectron || process.env.E2E_MOCK) && isLocalhostHost(parsed.hostname)) {
      return parsed
    }
    throw new Error(
      `URL must not point to a private or loopback address: ${parsed.hostname}`,
    )
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
