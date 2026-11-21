/**
 * Browser Stream WebSocket Proxy
 *
 * Handles WebSocket upgrade requests for /api/agents/:slug/browser/stream
 * and proxies them bidirectionally to the agent container's /browser/stream endpoint.
 * `admitBrowserStream` and `serveBrowserStream` hold all of it but the upgrade, so a
 * runtime that accepts sockets another way serves the same stream.
 */

import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import type { ServerType } from '@hono/node-server'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { agentCatalog, agentRegistry, type WebSocketTarget } from '@shared/lib/agent-actor'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { getSettings } from '@shared/lib/config/settings'
import { captureException } from '@shared/lib/error-reporting'
import { authenticateAgentWebSocket, type UpgradeRequest } from './agent-websocket-auth'
import { BrowserFrameRelay } from './browser-frame-relay'
import type { BrowserViewportCommand } from '@shared/lib/browser-stream-protocol'

const browserWss = new WebSocketServer({ noServer: true })

/** A real viewport command is tiny, so a view-only client can't make this event loop parse anything large. */
const MAX_VIEWPORT_COMMAND_BYTES = 256

const BROWSER_STREAM_PATH = /^\/api\/agents\/([^/]+)\/browser\/stream$/

/** Opens the socket to a container at a target, the way this runtime reaches its containers. */
export type ConnectToContainer = (target: WebSocketTarget) => WebSocket

/** Who the upgrade lets in: the agent, whether they may send input, and the query the container gets. */
export interface BrowserStreamViewer {
  agentSlug: string
  canInput: boolean
  upstreamSearch: string
}

/** The checks before the upgrade. A status to refuse the upgrade with when they fail. */
export async function admitBrowserStream(
  slugInUrl: string,
  url: URL,
  request: UpgradeRequest,
): Promise<BrowserStreamViewer | { status: 403 | 404 | 502 }> {
  try {
    // The URL carries the display slug ({name}-{id}); resolve to the canonical id
    // before any ACL check or container lookup. This WS upgrade bypasses the Hono
    // /:id/* ResolveAgent middleware, so it must resolve itself.
    const agentSlug = await agentCatalog.resolve(slugInUrl)
    if (!agentSlug) return { status: 404 }
    // Viewer+ can watch, but input is filtered per-role in serveBrowserStream.
    if (!(await authenticateAgentWebSocket(request, agentSlug, 'viewer'))) return { status: 403 }
    const canInput = await authenticateAgentWebSocket(request, agentSlug, 'user')
    // Only the width goes on to the container, not the rest of the viewer's URL.
    const width = url.searchParams.get('width')
    return { agentSlug, canInput, upstreamSearch: width && /^\d+$/.test(width) ? `?width=${width}` : '' }
  } catch (error) {
    captureException(error, {
      tags: { component: 'browser-proxy', operation: 'authorize' },
      extra: { slugInUrl },
    })
    return { status: 502 }
  }
}

const DENIED: Record<number, string> = { 403: '403 Forbidden', 404: '404 Not Found', 502: '502 Bad Gateway' }

/** Proxies an accepted client socket to the agent container's browser stream. */
export async function serveBrowserStream(ws: WebSocket, viewer: BrowserStreamViewer, connect: ConnectToContainer): Promise<void> {
  const { agentSlug, canInput } = viewer

  // Upstream can take seconds to open (a Lambda microVM). Input from before then is stale, but the
  // renderer reports the canvas width only when it changes, so the latest one waits for upstream.
  let openUpstream: WebSocket | undefined
  let pendingViewport: RawData | undefined
  ws.on('message', (data, isBinary) => {
    const upstream = openUpstream?.readyState === WebSocket.OPEN ? openUpstream : undefined
    if (upstream && canInput) {
      upstream.send(data, { binary: isBinary })
      return
    }
    // Viewers can watch but not send input; their canvas width only sizes the frames.
    if (isBinary || !isViewportCommand(data as Buffer)) return
    if (upstream) upstream.send(data, { binary: false })
    else pendingViewport = data
  })

  try {
    // Cached status only — no runtime query
    const actor = agentRegistry.get(agentSlug)
    const target = await actor.container.webSocketTarget('/browser/stream', {
      search: viewer.upstreamSearch,
    })
    // The viewer can leave while the target is read, before the close handler below exists.
    if (ws.readyState !== WebSocket.OPEN) return
    if (!target) {
      ws.close(1011, 'Agent container is not running')
      return
    }

    console.log(`[BrowserProxy] Connecting upstream to /browser/stream for agent ${agentSlug}`)
    const upstream = connect(target)
    // Set when the viewer left while upstream was connecting: the error that ending the connect raises is expected.
    let abandoned = false

    upstream.on('open', () => {
      if (ws.readyState !== WebSocket.OPEN) {
        upstream.close()
        return
      }
      console.log(`[BrowserProxy] Connected to container stream for agent ${agentSlug}`)
      openUpstream = upstream
      if (pendingViewport) upstream.send(pendingViewport, { binary: false })
      getSettings()
        .then((settings) => {
          trackServerEvent('browser_opened', { using: settings.app?.hostBrowserProvider ?? 'container' })
        })
        .catch((error) => {
          console.error('[BrowserProxy] Could not read the browser provider for analytics:', error)
        })
    })

    // Forward frames from container to client, preserving text/binary
    // framing. The relay holds screencast frames back while the client's
    // link is congested and sends the newest once it drains (see its doc).
    const relay = new BrowserFrameRelay(ws)
    upstream.on('message', (data, isBinary) => relay.forward(data as Buffer, isBinary))

    upstream.on('close', () => {
      // Paired with browser_opened: a connection that never opened is not a closed browser.
      if (openUpstream) trackServerEvent('browser_closed')
      if (ws.readyState === WebSocket.OPEN) {
        ws.close()
      }
    })

    ws.on('close', () => {
      relay.close()
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.close()
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        abandoned = true
        upstream.terminate()
      }
    })

    upstream.on('error', (error) => {
      if (abandoned) return
      console.error(`[BrowserProxy] Upstream error for agent ${agentSlug}:`, error)
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, 'Upstream connection error')
      }
      // A reset from a container that is going away is expected; anything else is reported.
      const isConnectionReset = error instanceof Error && (error.message.includes('ECONNRESET') || error.message.includes('socket hang up'))
      void actor.container.status().then(({ status: containerStatus }) => {
        if (isConnectionReset && containerStatus !== 'running') return
        captureException(error, {
          tags: { component: 'browser-proxy', operation: 'upstream-ws', containerStatus },
          extra: { agentSlug },
        })
      }, () => {})
    })

    ws.on('error', (error) => {
      console.error(`[BrowserProxy] Client error for agent ${agentSlug}:`, error)
      // Client errors are often normal disconnects, only report non-trivial ones
      if (!(error instanceof Error && error.message.includes('ECONNRESET'))) {
        captureException(error, {
          tags: { component: 'browser-proxy', operation: 'client-ws' },
          extra: { agentSlug },
          level: 'warning',
        })
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.close()
      }
    })
  } catch (error) {
    console.error(`[BrowserProxy] Failed to set up proxy for agent ${agentSlug}:`, error)
    captureException(error, {
      tags: { component: 'browser-proxy', operation: 'setup' },
      extra: { agentSlug },
    })
    ws.close(1011, 'Failed to connect to browser stream')
  }
}

export function setupBrowserStreamProxy(server: ServerType): void {
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- request.url from HTTP server is always valid
    const url = new URL(request.url || '', `http://${request.headers.host}`)
    const match = url.pathname.match(BROWSER_STREAM_PATH)

    if (!match) {
      // Not a browser stream request — don't touch it, let other handlers handle it
      return
    }

    admitBrowserStream(match[1], url, request).then((admitted) => {
      if ('status' in admitted) {
        socket.write(`HTTP/1.1 ${DENIED[admitted.status]}\r\n\r\n`)
        socket.destroy()
        return
      }
      browserWss.handleUpgrade(request, socket, head, (ws) => {
        void serveBrowserStream(ws, admitted, (target) => new WebSocket(target.url, target.protocols, { headers: target.headers }))
      })
    }).catch(() => {
      socket.destroy()
    })
  })
}

function isViewportCommand(data: Buffer): boolean {
  if (data.length > MAX_VIEWPORT_COMMAND_BYTES) return false
  try {
    return (JSON.parse(data.toString()) as Partial<BrowserViewportCommand> | null)?.type === 'viewport'
  } catch {
    return false
  }
}
