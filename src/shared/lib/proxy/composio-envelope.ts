/**
 * Helpers that translate between an HTTP request/response and Composio's
 * proxy execute envelope shape. Used only on the Composio-managed (redacted)
 * connection path — user-managed connections forward bytes directly.
 */

import type {
  ProxyExecuteParameter,
  ProxyExecuteResult,
} from '@shared/lib/composio/client'

/**
 * Headers that must NEVER be forwarded to the upstream (either directly or via
 * Composio's proxy `parameters` array). `host` and `content-length` would be
 * wrong; `authorization` is replaced by Composio's injected token; the
 * `connection`/`transfer-encoding`/`accept-encoding` triplet is hop-by-hop.
 */
export const PROXY_SKIP_REQUEST_HEADERS = new Set([
  'host',
  'authorization',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
])

/**
 * Response headers we strip when relaying upstream → agent. `transfer-encoding`
 * is hop-by-hop; `content-encoding` and `content-length` would be wrong because
 * fetch() auto-decompresses (direct path) or because we re-serialize JSON
 * (proxy path).
 */
export const PROXY_SKIP_RESPONSE_HEADERS = new Set([
  'transfer-encoding',
  'content-encoding',
  'content-length',
])

/**
 * Build the `parameters` array Composio expects from an incoming request's
 * Headers. Drops hop-by-hop headers, the synthetic Authorization, and Cookie
 * (the agent's local cookies must not leak to the upstream service).
 *
 * Query parameters are NOT emitted here — the proxy route already embeds them
 * in the `endpoint` URL, and Composio doesn't merge both sources.
 */
export function buildProxyParameters(headers: Headers): ProxyExecuteParameter[] {
  const parameters: ProxyExecuteParameter[] = []
  headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (PROXY_SKIP_REQUEST_HEADERS.has(lower)) return
    if (lower === 'cookie') return
    parameters.push({ name: key, value, type: 'header' })
  })
  return parameters
}

/**
 * Translate Composio's proxy response envelope (`{status, data, headers,
 * binary_data?}`) into a Response we can return to the calling agent.
 *
 *  - `binaryData.url` set: stream that URL through (preserves byte content,
 *    sets content-type from the envelope).
 *  - `data` is a string: pass through as text, defaulting content-type to
 *    text/plain when the envelope didn't supply one.
 *  - `data` is a JSON value (object / array / null / number / boolean):
 *    re-serialize and force application/json.
 *
 * `fetchImpl` is injectable so tests can avoid the real network.
 */
export async function envelopeToResponse(
  result: ProxyExecuteResult,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const responseHeaders = new Headers()
  for (const [k, v] of Object.entries(result.headers ?? {})) {
    if (!PROXY_SKIP_RESPONSE_HEADERS.has(k.toLowerCase())) {
      responseHeaders.set(k, v)
    }
  }

  if (result.binaryData?.url) {
    try {
      const upstream = await fetchImpl(result.binaryData.url)
      responseHeaders.set('Content-Type', result.binaryData.content_type)
      return new Response(upstream.body, {
        status: result.status,
        headers: responseHeaders,
      })
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: 'Failed to fetch binary response',
          details: String(error),
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      )
    }
  }

  if (typeof result.data === 'string') {
    if (!responseHeaders.has('content-type')) {
      responseHeaders.set('Content-Type', 'text/plain; charset=utf-8')
    }
    return new Response(result.data, {
      status: result.status,
      headers: responseHeaders,
    })
  }

  responseHeaders.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(result.data ?? null), {
    status: result.status,
    headers: responseHeaders,
  })
}
