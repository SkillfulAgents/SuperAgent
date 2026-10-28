/**
 * Cloud Workspace WebSocket Proxy
 *
 * The upgrade half of the cloud proxy (`api/routes/cloud-proxy.ts`). Hono only
 * sees requests the HTTP server has already finished parsing, so a `101
 * Switching Protocols` never reaches it — an upgrade leaves the request/response
 * cycle entirely and arrives on the server's own `upgrade` event instead. That
 * is why the two halves of one feature live in two files.
 *
 * Without this, the browser view (`use-browser-stream.ts`, the renderer's one
 * WebSocket) is simply dead against a cloud workspace.
 */

import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import type { ServerType } from '@hono/node-server'
import { WebSocketServer, WebSocket } from 'ws'
import { captureException } from '@shared/lib/error-reporting'
import { isCloudProxyEnabled, CLOUD_PROXY_PREFIX } from '../api/routes/cloud-proxy'
import { isCloudProxyKey } from '@shared/lib/services/cloud-proxy-key'
import {
  refreshCloudProxyTarget,
  resolveCloudProxyTarget,
  type CloudProxyTarget,
} from '@shared/lib/services/cloud-proxy-target'

const cloudWss = new WebSocketServer({ noServer: true })

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** Mirrors the HTTP half's Origin check — see cloud-proxy.ts. */
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

function upstreamUrlFor(target: CloudProxyTarget, pathAndQuery: string): string {
  // Same origin, different scheme. https → wss is not cosmetic: it is what keeps
  // the bearer off the wire in the clear.
  const wsOrigin = target.deploymentUrl.replace(/^http/, 'ws')
  return `${wsOrigin}${pathAndQuery}`
}

/**
 * Open the upstream socket, re-minting once if the deployment rejects the token.
 *
 * The upstream connection is made *before* the client is upgraded, which is the
 * opposite of what the sibling browser-stream proxy does. It matters here: a 401
 * on the handshake is the expected state every 24 hours, and once we have
 * answered the browser `101` the only thing left to say is a close code. Doing
 * it in this order, a re-mint is invisible — the browser is still waiting.
 */
function connectUpstream(pathAndQuery: string): Promise<WebSocket> {
  const attempt = (target: CloudProxyTarget, retryOn401: boolean): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const upstream = new WebSocket(upstreamUrlFor(target, pathAndQuery), {
        headers: { authorization: `Bearer ${target.token}` },
      })

      // Whether this attempt's outcome is already decided. Tearing down a
      // half-open socket makes `ws` emit an error of its own ("closed before the
      // connection was established"), which would otherwise settle the promise
      // out from under the retry we are in the middle of.
      let handled = false

      upstream.once('open', () => {
        handled = true
        resolve(upstream)
      })

      // A non-101 answer arrives here rather than as an error, and carries the
      // status we need to tell "expired" from "broken".
      upstream.once('unexpected-response', (_req, res) => {
        handled = true
        res.resume() // drain, or the socket is held open
        upstream.terminate()
        if (res.statusCode !== 401 || !retryOn401) {
          reject(new Error(`cloud workspace refused the stream (${res.statusCode})`))
          return
        }
        refreshCloudProxyTarget()
          .then((refreshed) => {
            if (!refreshed) throw new Error('cloud workspace refused the stream (401)')
            return attempt(refreshed, false)
          })
          .then(resolve, reject)
      })

      upstream.once('error', (error) => {
        if (handled) return
        handled = true
        upstream.terminate()
        reject(error)
      })
    })

  const target = resolveCloudProxyTarget()
  if (!target) return Promise.reject(new Error('no cloud workspace token is available'))
  return attempt(target, true)
}

/** Pipe both directions until either side closes, preserving text/binary framing. */
function bridge(client: WebSocket, upstream: WebSocket, path: string): void {
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
  })
  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
  })

  upstream.on('close', (code, reason) => {
    // Codes below 3000 are reserved and cannot be sent by an application, so a
    // relayed 1006 (abnormal, never actually transmitted) would throw here.
    if (client.readyState === WebSocket.OPEN) {
      client.close(code >= 3000 ? code : 1011, reason.toString().slice(0, 120))
    }
  })
  client.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close()
  })

  for (const [side, socket, peer] of [
    ['upstream', upstream, client],
    ['client', client, upstream],
  ] as const) {
    socket.on('error', (error) => {
      // A disconnect mid-stream is how most of these end; only the unexpected
      // ones are worth a report.
      if (!(error instanceof Error && error.message.includes('ECONNRESET'))) {
        captureException(error, {
          tags: { component: 'cloud-stream-proxy', operation: `${side}-ws` },
          extra: { path },
          level: side === 'client' ? 'warning' : 'error',
        })
      }
      if (peer.readyState === WebSocket.OPEN) peer.close()
    })
  }
}

export function setupCloudStreamProxy(server: ServerType): void {
  // Same gate as the HTTP half: Electron main, never inside a deployment.
  if (!isCloudProxyEnabled()) return

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- request.url from the HTTP server always parses
    const url = new URL(request.url || '', `http://${request.headers.host}`)
    const segments = url.pathname.split('/')

    // Not ours — leave the socket alone so the browser-stream proxy (or any
    // future handler) still gets its turn.
    if (`/${segments[1]}` !== CLOUD_PROXY_PREFIX) return

    const key = segments[2] ?? ''
    const upstreamPath = `/${segments.slice(3).join('/')}`

    const deny = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
    }

    const remoteAddress = request.socket?.remoteAddress
    if (!remoteAddress || !LOOPBACK_ADDRESSES.has(remoteAddress)) return deny('403 Forbidden')
    if (!isLocalRendererOrigin(request.headers.origin)) return deny('403 Forbidden')
    if (!isCloudProxyKey(key)) return deny('404 Not Found')
    if (upstreamPath !== '/api' && !upstreamPath.startsWith('/api/')) return deny('404 Not Found')

    connectUpstream(upstreamPath + url.search)
      .then((upstream) => {
        // The client may have given up while the upstream handshake (and
        // possibly a token re-mint) was in flight.
        if (socket.destroyed) {
          upstream.terminate()
          return
        }
        cloudWss.handleUpgrade(request, socket, head, (client) => {
          bridge(client, upstream, upstreamPath)
        })
      })
      .catch((error) => {
        console.error('[cloud-stream-proxy] Upstream connection failed:', error)
        deny('502 Bad Gateway')
      })
  })
}
