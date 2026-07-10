/**
 * Loopback hostnames that resolve to the machine itself. Inside an agent
 * container these point at the container, not the host, so a host-reachable
 * URL using them is unreachable from the container.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1'])

/**
 * Rewrite a loopback URL to the container-reachable host gateway
 * (host.docker.internal — forwarded by Docker Desktop/Lima, and added via
 * --add-host on Linux). Matches on the parsed hostname, so loopback IPs are
 * covered and hostnames that merely start with "localhost"
 * (e.g. localhost.mycorp.dev) are left alone. Non-URL input passes through
 * unchanged.
 */
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
