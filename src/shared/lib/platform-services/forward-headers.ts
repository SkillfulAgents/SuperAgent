/**
 * Header filters for host → platform service forwarding.
 *
 * Request side is an allowlist (only content-type / accept / prefer).
 * Response side strips framing + credential headers that must not reach the
 * agent after Node re-frames the upstream body.
 */

const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'prefer'] as const

/** Cloud-proxy framing set, plus Authorization / WWW-Authenticate. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'set-auth-token',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'authorization',
  'www-authenticate',
])

/**
 * Build upstream headers: allowlisted inbound fields, then Authorization last
 * so a caller cannot present its own credential through us.
 */
export function buildUpstreamHeaders(request: Request, bearerToken: string): Headers {
  const headers = new Headers()
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  headers.set('authorization', `Bearer ${bearerToken}`)
  return headers
}

/** Copy upstream response headers, dropping framing and credential fields. */
export function buildClientHeaders(upstream: { headers: Headers }): Headers {
  const headers = new Headers()
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) return
    if (lower.startsWith('access-control-')) return
    headers.set(name, value)
  })
  return headers
}
