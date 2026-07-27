import { Hono } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { isAuthMode } from '@shared/lib/auth/mode'
import { isCloudProxyKey } from '@shared/lib/services/cloud-proxy-key'
import {
  refreshCloudProxyTarget,
  resolveCloudProxyTarget,
  type CloudProxyTarget,
} from '@shared/lib/services/cloud-proxy-target'

/**
 * Cloud proxy — the desktop app's path to its organization's cloud deployment.
 *
 * The renderer does not talk to the deployment directly. It cannot: the packaged
 * renderer loads from `file://`, so its requests arrive with `Origin: null`,
 * which an auth-mode deployment's origin allowlist has no way to admit. And five
 * of the renderer's network call sites — two `EventSource`s, `<img src>`,
 * `<iframe src>`, and Electron's `downloadURL` — cannot carry an `Authorization`
 * header at all, so a token in the renderer would not reach them.
 *
 * So the renderer keeps calling loopback, and this route forwards. The
 * deployment token stays in the main process, and every call site works
 * unchanged because the only thing that moves is the prefix `getApiBaseUrl()`
 * returns.
 *
 * Mounted at `/cloud/{key}`, and `{key}` is load-bearing — see
 * `cloud-proxy-key.ts` for why the secret is in the path.
 */
export const CLOUD_PROXY_PREFIX = '/cloud'

/**
 * Whether this process may run the proxy at all.
 *
 * Electron main only, and never in an auth-mode deployment: a deployment
 * proxying to a deployment is either a loop or a confused deputy with an
 * org-wide credential attached. Same reasoning as the discovery feature's
 * Electron-only gate (`docs/cloud-workspace.md`).
 */
export function isCloudProxyEnabled(): boolean {
  return process.type === 'browser' && !isAuthMode()
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * Request headers forwarded upstream. An allowlist, not a denylist: everything
 * here is a header we know the deployment needs, and anything the desktop or a
 * local middleware adds later is dropped by default rather than silently
 * relayed to a remote host.
 *
 * `last-event-id` and `range` are not incidental — they are what make an
 * interrupted SSE stream resume and a media/file preview seek, which is most of
 * what the headerless call sites above actually do.
 *
 * `accept-encoding` is deliberately absent: the upstream fetch negotiates and
 * transparently decodes its own compression, so relaying the renderer's
 * preference would only invite a body whose framing no longer matches the
 * headers we pass back.
 */
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'cache-control',
  'content-type',
  'if-modified-since',
  'if-none-match',
  'last-event-id',
  'range',
]

/**
 * Response headers dropped on the way back.
 *
 * - `set-cookie` / `set-auth-token`: session credentials for the *deployment's*
 *   origin. Landing them on a loopback origin gives the renderer a second,
 *   unmanaged copy of the credential this proxy exists to hold on its behalf.
 * - `content-encoding` / `content-length` / hop-by-hop: we re-frame the body, so
 *   the upstream's framing metadata describes something that no longer exists.
 * - `access-control-*`: the local server's own CORS middleware answers for this
 *   origin. Two sets of CORS headers is not permissive, it is a rejected
 *   response.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'set-auth-token',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
])

/**
 * Largest request body buffered so it can be replayed after a token refresh.
 * Above this the body is streamed straight through, which is the right call for
 * a file upload but costs that request its retry (see `forwardRequest`).
 */
const REPLAYABLE_BODY_LIMIT = 2 * 1024 * 1024

/**
 * Whether the caller is the local renderer rather than a web page that happened
 * to learn the port.
 *
 * Absent or `null` Origin is the normal case — the packaged renderer is
 * `file://`, and `<img>`/`EventSource` requests may send no Origin at all. What
 * this rejects is the case that matters: a real site, whose Origin the browser
 * always attaches and cannot forge.
 */
function isLocalRendererOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return true
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol === 'file:') return true
  return LOOPBACK_HOSTNAMES.has(parsed.hostname)
}

interface ForwardableBody {
  body: BodyInit | null
  /** Whether this request can be sent a second time after a token refresh. */
  replayable: boolean
}

/**
 * The body to forward, and whether sending it twice is possible.
 *
 * No body at all is the trivially replayable case, and it is not only GET/HEAD:
 * agent start/stop/delete, interrupt, mark-notification-read and friends are
 * bodyless POSTs and DELETEs. Denying those the retry would have withheld it
 * from exactly the mutations a user is likely to be making when a session
 * expires.
 *
 * Emptiness is read off the **HTTP framing**, not off `request.body`. The Node
 * adapter hands every non-GET/HEAD request a `ReadableStream` whether or not
 * any bytes follow it, so the Fetch property answers "there is a body" for a
 * bare `DELETE`. The framing does not: RFC 9112 §6 says a request with neither
 * `Content-Length` nor `Transfer-Encoding` has no body, full stop.
 *
 * Otherwise, a declared length at or under the limit is read into memory so a
 * 401 can be retried transparently — that covers every JSON call the renderer
 * makes. A larger or undeclared length is streamed instead: buffering a file
 * upload to buy it one retry is the wrong trade, and an undeclared length is
 * unbounded.
 */
async function readForwardableBody(request: Request): Promise<ForwardableBody> {
  const declared = request.headers.get('content-length')
  const chunked = request.headers.get('transfer-encoding') !== null

  if (!chunked && (declared === null || Number(declared) === 0)) {
    return { body: null, replayable: true }
  }
  if (request.body === null) return { body: null, replayable: true }

  const declaredLength = declared === null ? Number.NaN : Number(declared)
  if (Number.isFinite(declaredLength) && declaredLength <= REPLAYABLE_BODY_LIMIT) {
    return { body: await request.arrayBuffer(), replayable: true }
  }
  return { body: request.body, replayable: false }
}

function buildUpstreamHeaders(request: Request, token: string): Headers {
  const headers = new Headers()
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  // Set last, and unconditionally: an inbound Authorization is never forwarded,
  // so a caller cannot present its own credential to the deployment through us.
  headers.set('authorization', `Bearer ${token}`)
  return headers
}

function buildClientHeaders(upstream: Response): Headers {
  const headers = new Headers()
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) return
    if (lower.startsWith('access-control-')) return
    headers.set(name, value)
  })
  return headers
}

const cloudProxy = new Hono()

cloudProxy.all('/*', async (c) => {
  const request = c.req.raw

  // 1. Loopback peer. The server binds 0.0.0.0 for the agent containers, so
  //    "only reachable locally" is not something the socket gives us for free.
  const remoteAddress = getConnInfo(c).remote.address
  if (!remoteAddress || !LOOPBACK_ADDRESSES.has(remoteAddress)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  // 2. Not a browsing context that belongs to someone else.
  if (!isLocalRendererOrigin(request.headers.get('origin') ?? undefined)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  // 3. Split the path without decoding it. `/cloud/{key}/api/...` — the key is
  //    compared as it arrived (base64url needs no escaping, so anything that
  //    had to be decoded to match was not the key), and the upstream path keeps
  //    the caller's exact encoding rather than a re-encoded approximation.
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url comes from the HTTP server and always parses
  const requestUrl = new URL(request.url)
  const segments = requestUrl.pathname.split('/')
  const key = segments[2] ?? ''
  const upstreamPath = `/${segments.slice(3).join('/')}`

  // A wrong key and a path that isn't ours both answer 404: a prober learns
  // only that there is nothing here, not that there is something here it failed
  // to unlock.
  if (!isCloudProxyKey(key)) return c.json({ error: 'Not found' }, 404)
  if (upstreamPath !== '/api' && !upstreamPath.startsWith('/api/')) {
    return c.json({ error: 'Not found' }, 404)
  }

  const target = resolveCloudProxyTarget()
  if (!target) {
    return c.json(
      {
        error: 'cloud_workspace_unavailable',
        message: 'No cloud workspace token is available. Reconnect the workspace and try again.',
      },
      503,
    )
  }

  return forwardRequest(c.req.raw, target, upstreamPath + requestUrl.search)
})

async function forwardRequest(
  request: Request,
  target: CloudProxyTarget,
  pathAndQuery: string,
): Promise<Response> {
  const { body, replayable } = await readForwardableBody(request)

  const send = (activeTarget: CloudProxyTarget): Promise<Response> =>
    fetch(`${activeTarget.deploymentUrl}${pathAndQuery}`, {
      method: request.method,
      headers: buildUpstreamHeaders(request, activeTarget.token),
      body,
      // A ReadableStream body is rejected by Node's fetch without this.
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
      // Redirects are resolved here, not handed back. A relative `Location`
      // returned to the renderer would resolve against the loopback origin and
      // silently re-issue the call against the *local* API — the one place a
      // cloud-mode request must never land. (fetch drops the Authorization
      // header on a cross-origin hop, so following costs no credential.)
      redirect: 'follow',
      signal: request.signal,
    } as RequestInit)

  let upstream: Response
  try {
    upstream = await send(target)
  } catch (error) {
    return upstreamFailure(request, error)
  }

  if (upstream.status === 401) {
    // Read the body out before deciding: if we end up returning this response
    // we still owe the caller its content, and a retry means abandoning it.
    const rejectionBody = await upstream.arrayBuffer().catch(() => new ArrayBuffer(0))
    const refreshed = await refreshCloudProxyTarget()

    // A streamed body is already consumed, so there is nothing to replay. The
    // refresh above still ran — the next request the user makes will work,
    // which for an upload means the retry the UI offers them succeeds.
    if (refreshed && replayable) {
      try {
        upstream = await send(refreshed)
      } catch (error) {
        return upstreamFailure(request, error)
      }
      return toClientResponse(upstream)
    }
    return new Response(rejectionBody, {
      status: 401,
      headers: buildClientHeaders(upstream),
    })
  }

  return toClientResponse(upstream)
}

function toClientResponse(upstream: Response): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: buildClientHeaders(upstream),
  })
}

/**
 * A failed upstream call. A client that navigated away mid-stream is the normal
 * end of every SSE connection, not an error worth a status the renderer would
 * surface — and there is no longer anyone to send it to anyway.
 */
function upstreamFailure(request: Request, error: unknown): Response {
  if (request.signal.aborted) return new Response(null, { status: 499 })
  console.error('[cloud-proxy] Upstream request failed:', error)
  return Response.json(
    { error: 'cloud_workspace_unreachable', message: 'The cloud workspace could not be reached.' },
    { status: 502 },
  )
}

export default cloudProxy
