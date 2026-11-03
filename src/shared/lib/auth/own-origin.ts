import { getAppPort } from '@shared/lib/proxy/host-url'
import { getTrustedOrigins } from './trusted-origins'

/** A hostname as compared: lowercase, without IPv6 brackets or a trailing dot. */
function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
}

/** The URL's port, or its scheme's default. */
function portOf(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '')
}

function ipv4Bytes(name: string): number[] | null {
  const parts = name.split('.')
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null
  const bytes = parts.map(Number)
  return bytes.every((byte) => byte <= 255) ? bytes : null
}

/** `::ffff:7f00:1` (as URLs write an IPv4-mapped address) as `127.0.0.1`. */
function unmapIpv4(name: string): string {
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(name)
  if (!mapped) return name
  if (mapped[1]) return mapped[1]
  const high = parseInt(mapped[2], 16)
  const low = parseInt(mapped[3], 16)
  return [high >> 8, high & 255, low >> 8, low & 255].join('.')
}

/**
 * This machine or its private network, as a container reaches the host:
 * loopback, private, shared and link-local addresses, `localhost` and
 * `*.localhost`, `*.internal` (host.docker.internal,
 * host.containers.internal), and single-label names.
 */
export function isLocalHostname(hostname: string): boolean {
  const name = unmapIpv4(normalizeHostname(hostname))
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.internal')) return true
  const v4 = ipv4Bytes(name)
  if (v4) {
    const [a, b] = v4
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
  }
  if (name.includes(':')) return name === '::1' || name === '::' || /^f[cd]/.test(name) || /^fe[89ab]/.test(name)
  return !name.includes('.')
}

/**
 * Whether `origin` is one of this app's own addresses: one the app is
 * configured to be reached at (trusted origins, HOST, HOST_PUBLIC_URL) or
 * this request reached it at (`requestUrls`); any port of such a public
 * hostname; or this machine and its private network on the app's port,
 * where a container reaches the host whatever it is called there.
 */
export function isOwnOrigin(origin: string, requestUrls: Array<string | undefined>): boolean {
  let target: URL
  try {
    target = new URL(origin)
  } catch {
    return false
  }
  const hostname = normalizeHostname(target.hostname)
  const port = portOf(target)
  const configured = [
    ...getTrustedOrigins(),
    process.env.HOST && `http://${process.env.HOST}:${getAppPort()}`,
    process.env.HOST_PUBLIC_URL,
  ]
  const own: URL[] = []
  for (const candidate of [...requestUrls, ...configured]) {
    if (!candidate) continue
    try {
      own.push(new URL(candidate))
    } catch {
      // Not a URL: names nothing to compare.
    }
  }
  for (const url of own) {
    const ownName = normalizeHostname(url.hostname)
    if (ownName === hostname && (portOf(url) === port || !isLocalHostname(ownName))) return true
  }
  const localPorts = new Set([String(getAppPort()), ...own.filter((url) => isLocalHostname(url.hostname)).map(portOf)])
  return isLocalHostname(hostname) && localPorts.has(port)
}
