/**
 * Loopback hostnames that resolve to the machine itself. Inside an agent
 * container these point at the container, not the host, so a host-reachable
 * URL using them is unreachable from the container.
 */
// URL.hostname keeps the brackets on IPv6 literals, so '[::1]' (not '::1') is
// what a parsed loopback IPv6 URL yields.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

/**
 * Rewrite a loopback URL to the container-reachable host gateway
 * (host.docker.internal — forwarded by Docker Desktop/Lima, and added via
 * --add-host on Linux). Matches on the parsed hostname, so loopback IPs are
 * covered and hostnames that merely start with "localhost"
 * (e.g. localhost.mycorp.dev) are left alone. Non-URL input passes through
 * unchanged.
 */
/**
 * True when a parsed URL hostname is a single-label name (no dots) that only
 * resolves through host-side mechanisms Docker's DNS forwarder does not apply
 * — the host's search domains and scoped resolvers (Tailscale MagicDNS, mDNS
 * without the .local suffix). Such a URL works on the host but is
 * unresolvable inside the agent container. Loopback names are excluded
 * because rewriteLoopbackForContainer translates them, and bracketed IPv6
 * literals are dot-free without being hostnames at all.
 */
export function isHostOnlyHostname(hostname: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return false
  if (hostname.startsWith('[')) return false
  return !hostname.includes('.')
}

export function rewriteLoopbackForContainer(url: string | undefined): string | undefined {
  if (!url) return url
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return url
  parsed.hostname = 'host.docker.internal'
  const rewritten = parsed.toString()
  // URL.toString() appends a trailing slash to a bare origin; don't introduce
  // one the caller didn't have.
  return url.endsWith('/') ? rewritten : rewritten.replace(/\/$/, '')
}
