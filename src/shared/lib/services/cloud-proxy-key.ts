import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The per-boot secret that gates the cloud proxy.
 *
 * The local API server is loopback-only, but loopback is not a boundary a
 * browser respects: in local mode CORS is `*`, so any page the user visits can
 * already call `http://127.0.0.1:{port}/api/...`. That is tolerable for a local
 * install — the attacker reaches a server on the user's own machine. It is not
 * tolerable for the cloud proxy, which would hand that same page an
 * authenticated channel to the organization's whole deployment.
 *
 * **The secret lives in the URL path, not in a header.** That looks like the
 * weaker choice and is in fact the only workable one: the requests this proxy
 * exists to serve include `EventSource`, `<img src>`, `<iframe src>` and
 * Electron's `downloadURL`, none of which can carry a custom header. A
 * header-based gate would fail for exactly the call sites that motivated
 * proxying in the first place. Since the prefix is what `getApiBaseUrl()`
 * returns, every call site picks it up with no per-site change.
 *
 * What that costs: the secret appears in request paths, so it can land in logs.
 * It is therefore regenerated on every boot and never persisted — a leaked
 * value is useless after a restart, and useless from off-machine regardless
 * (the route still requires a loopback peer).
 */
let cachedKey: string | null = null

/**
 * The current process's proxy key, generated on first use. 256 bits from the
 * CSPRNG, base64url so it is a single path segment with no escaping.
 */
export function getCloudProxyKey(): string {
  if (!cachedKey) cachedKey = randomBytes(32).toString('base64url')
  return cachedKey
}

/**
 * Whether `candidate` is this process's key. Compared in constant time: the key
 * sits in a path, so a caller can probe it a character at a time, and `===`
 * would leak the prefix length through timing.
 */
export function isCloudProxyKey(candidate: string): boolean {
  const expected = Buffer.from(getCloudProxyKey())
  const actual = Buffer.from(candidate)
  // timingSafeEqual throws on a length mismatch, so length is checked first and
  // is not itself secret — the key is a fixed 43 characters.
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/** Test seam: forces the next {@link getCloudProxyKey} to mint a fresh key. */
export function _resetCloudProxyKeyForTest(): void {
  cachedKey = null
}
