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
 *   - validateMcpDiscoveryUrl(url): async SSRF guard for remote-MCP / OAuth
 *     discovery (string policy + DNS resolve; rejects private resolved IPs)
 *   - mcpSafeFetch(url, init?): fetch pinned to a vetted resolved address
 */

import { lookup } from 'node:dns/promises'
import { Agent } from 'undici'

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
  // IPv4-mapped — dotted or hex (URL.hostname canonicalizes to hex)
  const v4dotted = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4dotted) return isPrivateIPv4(v4dotted[1])
  const v4hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (v4hex) {
    const hi = Number.parseInt(v4hex[1], 16)
    const lo = Number.parseInt(v4hex[2], 16)
    return isPrivateIPv4(
      `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`,
    )
  }
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

function allowsLocalhostMcpException(hostname: string): boolean {
  const isElectron = process.type === 'browser'
  return Boolean((isElectron || process.env.E2E_MOCK) && isLocalhostHost(hostname))
}

type ResolvedAddress = { address: string; family: 4 | 6 }

/**
 * Resolve `hostname` to all addresses. Literal IP hostnames skip DNS and
 * return themselves so the private-host check still runs once.
 */
async function resolveHostnameAddresses(hostname: string): Promise<ResolvedAddress[]> {
  if (isPrivateIPv4(hostname) || isPrivateIPv6(hostname) || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    const family: 4 | 6 = hostname.includes(':') ? 6 : 4
    return [{ address: hostname.replace(/^\[/, '').replace(/\]$/, ''), family }]
  }
  const stripped = hostname.replace(/^\[/, '').replace(/\]$/, '')
  if (stripped.includes(':') || stripped === '::1') {
    return [{ address: stripped, family: 6 }]
  }

  const result = await lookup(hostname, { all: true })
  const list = Array.isArray(result) ? result : [result]
  return list.map((r) => ({
    address: r.address,
    family: (r.family === 6 ? 6 : 4) as 4 | 6,
  }))
}

/**
 * Resolve + apply the remote-MCP SSRF policy. Shared by validateMcpDiscoveryUrl
 * and mcpSafeFetch so pin and reject cannot drift.
 */
async function resolveMcpDiscoveryTarget(url: string): Promise<{
  parsed: URL
  addresses: ResolvedAddress[]
}> {
  const parsed = validateHttpUrl(url)
  const localhostOk = allowsLocalhostMcpException(parsed.hostname)

  if (isPrivateHost(parsed.hostname) && !localhostOk) {
    throw new Error(
      `URL must not point to a private or loopback address: ${parsed.hostname}`,
    )
  }

  const addresses = await resolveHostnameAddresses(parsed.hostname)
  if (addresses.length === 0) {
    throw new Error(`URL host could not be resolved: ${parsed.hostname}`)
  }

  for (const { address } of addresses) {
    if (isPrivateHost(address) && !localhostOk) {
      throw new Error(
        `URL must not point to a private or loopback address: ${parsed.hostname} (resolved ${address})`,
      )
    }
  }

  return { parsed, addresses }
}

/**
 * SSRF host policy for remote-MCP server and OAuth-discovery URLs.
 *
 * Runs validateHttpUrl + string isPrivateHost, then resolves DNS and rejects
 * if any resolved address is private/link-local — closing the DNS-rebind
 * axis that string-only checks miss. Localhost remains allowed only under
 * the Electron / E2E_MOCK exception.
 *
 * Returns the parsed URL on success; throws on rejection so callers can fail
 * closed without ever issuing the fetch.
 */
export async function validateMcpDiscoveryUrl(url: string): Promise<URL> {
  const { parsed } = await resolveMcpDiscoveryTarget(url)
  return parsed
}

/**
 * Outbound fetch for remote-MCP / OAuth discovery URLs: resolve+validate,
 * then connect pinned to a vetted address so a later DNS change cannot
 * redirect the socket (TOCTOU). Uses the undici Agent `connect.lookup` hook
 * so Host / SNI stay on the original hostname.
 */
export async function mcpSafeFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const { addresses } = await resolveMcpDiscoveryTarget(url)
  const pinned = addresses[0]

  const agent = new Agent({
    connect: {
      lookup(_hostname, _options, callback) {
        // undici 7 invokes lookup with `{ all: true }` and expects an address
        // list; the Node dns `(err, address, family)` shape yields undefined IP.
        callback(null, [{ address: pinned.address, family: pinned.family }])
      },
    },
  })

  try {
    // Preserve the caller URL string (path / trailing slash). Never auto-follow
    // redirects: a public host can 302 to a private target past this guard.
    // Node's DOM lib typings omit undici's `dispatcher`; runtime fetch accepts it.
    return await (fetch as (input: string, init?: RequestInit & { dispatcher?: Agent }) => Promise<Response>)(
      url,
      { ...init, dispatcher: agent, redirect: 'manual' },
    )
  } finally {
    void agent.close()
  }
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
