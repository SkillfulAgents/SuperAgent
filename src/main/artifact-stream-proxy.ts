/**
 * WebSocket half of the dashboard artifact reverse proxy (Vite HMR + app sockets).
 * `admitArtifactStream`, `artifactUpstreamOpened` and `bridgeArtifactStream` hold all
 * of it but the upgrade, so a runtime that accepts sockets another way serves the same proxy.
 */

import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import type { ServerType } from '@hono/node-server'
import { WebSocketServer, WebSocket } from 'ws'

import { agentCatalog, agentRegistry, type WebSocketTarget } from '@shared/lib/agent-actor'
import { captureException } from '@shared/lib/error-reporting'
import { authenticateAgentWebSocket, type UpgradeRequest } from './agent-websocket-auth'

export interface ArtifactWebSocketRoute {
  routeAgentId: string
  artifactSlug: string
  publicBasePath: string
  containerPath: string
}

interface ProtocolAwareRequest extends IncomingMessage {
  _gamutDashboardProtocol?: string
}

const artifactWss = new WebSocketServer({
  noServer: true,
  handleProtocols(protocols, request) {
    const selected = (request as ProtocolAwareRequest)._gamutDashboardProtocol
    return selected && protocols.has(selected) ? selected : false
  },
})

const SKIP_UPSTREAM_HEADERS = new Set([
  'connection',
  'host',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
  'upgrade',
  'x-superagent-host-token',
])

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export function parseArtifactWebSocketRoute(pathname: string): ArtifactWebSocketRoute | null {
  const match = pathname.match(/^\/api\/agents\/([^/]+)\/artifacts\/([^/]+)(\/.*)?$/)
  if (!match) return null

  const routeAgentId = decodePathSegment(match[1])
  const artifactSlug = decodePathSegment(match[2])
  if (!routeAgentId || !artifactSlug || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(artifactSlug)) {
    return null
  }

  const publicMount = `/api/agents/${match[1]}/artifacts/${match[2]}`
  return {
    routeAgentId,
    artifactSlug,
    publicBasePath: `${publicMount}/`,
    containerPath: `/artifacts/${encodeURIComponent(artifactSlug)}${match[3] || '/'}`,
  }
}

function requestProtocol(request: UpgradeRequest): string {
  const forwarded = request.headers['x-forwarded-proto']
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (value) return value.split(',')[0].trim()

  const origin = request.headers.origin
  if (origin) {
    try {
      return new URL(origin).protocol.replace(/:$/, '')
    } catch {
      // Fall through to socket encryption state.
    }
  }
  return request.socket?.encrypted ? 'https' : 'http'
}

export function artifactWebSocketForwardHeaders(
  request: UpgradeRequest,
  publicBasePath: string,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || SKIP_UPSTREAM_HEADERS.has(name.toLowerCase())) continue
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  headers['x-forwarded-prefix'] = publicBasePath.slice(0, -1)
  headers['x-forwarded-host'] = request.headers['x-forwarded-host']?.toString()
    || request.headers.host
    || ''
  headers['x-forwarded-proto'] = requestProtocol(request)
  const remoteAddress = request.socket?.remoteAddress
  if (remoteAddress) {
    const forwardedFor = request.headers['x-forwarded-for']
    const existing = Array.isArray(forwardedFor) ? forwardedFor.join(', ') : forwardedFor
    headers['x-forwarded-for'] = existing ? `${existing}, ${remoteAddress}` : remoteAddress
  }
  return headers
}

function requestedProtocols(request: UpgradeRequest): string[] {
  const raw = request.headers['sec-websocket-protocol']
  const value = Array.isArray(raw) ? raw.join(',') : raw
  return value ? value.split(',').map((protocol) => protocol.trim()).filter(Boolean) : []
}

function deny(socket: Duplex, status: string): void {
  if (socket.destroyed) return
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

function closePeer(peer: WebSocket, code?: number, reason?: Buffer): void {
  if (peer.readyState !== WebSocket.OPEN) return
  const relayCode = code === 1000 || (code !== undefined && code >= 3000) ? code : 1011
  peer.close(relayCode, reason?.toString().slice(0, 120))
}

/** Relays both ways once both sockets are open; each side closes with the other's code. */
export function bridgeArtifactStream(client: WebSocket, upstream: WebSocket, route: ArtifactWebSocketRoute): void {
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
  })
  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
  })
  upstream.on('close', (code, reason) => closePeer(client, code, reason))
  client.on('close', (code, reason) => closePeer(upstream, code, reason))

  for (const [side, socket, peer] of [
    ['dashboard', upstream, client],
    ['browser', client, upstream],
  ] as const) {
    socket.on('error', (error) => {
      if (!(error instanceof Error && error.message.includes('ECONNRESET'))) {
        captureException(error, {
          tags: { component: 'artifact-stream-proxy', operation: `${side}-ws` },
          extra: { artifactSlug: route.artifactSlug, routeAgentId: route.routeAgentId },
          level: side === 'browser' ? 'warning' : 'error',
        })
      }
      closePeer(peer)
    })
  }
}

/** What the upgrade may open: the route, and the dashboard's socket in the agent's container. */
export interface AdmittedArtifactStream {
  agentSlug: string
  route: ArtifactWebSocketRoute
  target: WebSocketTarget
}

/** The checks before the upgrade. A status to refuse the upgrade with when they fail. */
export async function admitArtifactStream(
  route: ArtifactWebSocketRoute,
  search: string,
  request: UpgradeRequest,
): Promise<AdmittedArtifactStream | { status: 403 | 404 | 502 | 503 }> {
  try {
    const agentSlug = await agentCatalog.resolve(route.routeAgentId)
    if (!agentSlug) return { status: 404 }
    if (!(await authenticateAgentWebSocket(request, agentSlug, 'viewer'))) return { status: 403 }
    // Forwarded headers first; the actor adds the container's auth headers after them.
    const target = await agentRegistry.get(agentSlug).container.webSocketTarget(route.containerPath, {
      search,
      protocols: requestedProtocols(request),
      headers: artifactWebSocketForwardHeaders(request, route.publicBasePath),
    })
    if (!target) return { status: 503 }
    return { agentSlug, route, target }
  } catch (error) {
    captureException(error, {
      tags: { component: 'artifact-stream-proxy', operation: 'authorize' },
      extra: { routeAgentId: route.routeAgentId, artifactSlug: route.artifactSlug },
    })
    return { status: 502 }
  }
}

/**
 * Calls `onOpen` in the dashboard socket's `open` event, so the client is upgraded with the
 * dashboard's chosen subprotocol and the relay listens before the dashboard's first message, which
 * can arrive with the handshake. Resolves false when the socket was refused or failed (reported,
 * and the socket terminated), or when `abandoned` fired first: the browser went away, nothing to report.
 */
export function artifactUpstreamOpened(
  upstream: WebSocket,
  admitted: AdmittedArtifactStream,
  onOpen: () => void,
  abandoned?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const fail = (error?: unknown) => {
      if (settled) return
      settled = true
      upstream.terminate()
      if (error) {
        captureException(error, {
          tags: { component: 'artifact-stream-proxy', operation: 'connect' },
          extra: { agentSlug: admitted.agentSlug, artifactSlug: admitted.route.artifactSlug },
        })
      }
      resolve(false)
    }
    upstream.once('unexpected-response', (_req, response) => {
      response.resume()
      fail(new Error(`Dashboard WebSocket refused upgrade (${response.statusCode})`))
    })
    upstream.once('error', fail)
    abandoned?.addEventListener('abort', () => fail(), { once: true })
    upstream.once('open', () => {
      if (settled) return
      settled = true
      onOpen()
      resolve(true)
    })
  })
}

const DENIED: Record<number, string> = {
  403: '403 Forbidden',
  404: '404 Not Found',
  502: '502 Bad Gateway',
  503: '503 Service Unavailable',
}

export function setupArtifactStreamProxy(server: ServerType): void {
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- server request URLs always parse
    const url = new URL(request.url || '', `http://${request.headers.host}`)
    const route = parseArtifactWebSocketRoute(url.pathname)
    if (!route) return

    void (async () => {
      const admitted = await admitArtifactStream(route, url.search, request)
      if ('status' in admitted) return deny(socket, DENIED[admitted.status])
      const { target } = admitted
      const upstream = new WebSocket(target.url, target.protocols, { headers: target.headers })
      let bridged = false
      const browserGone = new AbortController()
      // Also after the open: ws answers a handshake it rejects with 400 and never hands over the socket.
      socket.once('close', () => {
        if (bridged) return
        browserGone.abort()
        upstream.terminate()
      })
      const opened = await artifactUpstreamOpened(upstream, admitted, () => {
        if (socket.destroyed) {
          upstream.terminate()
          return
        }
        ;(request as ProtocolAwareRequest)._gamutDashboardProtocol = upstream.protocol || undefined
        artifactWss.handleUpgrade(request, socket, head, (browser) => {
          bridged = true
          bridgeArtifactStream(browser, upstream, route)
        })
      }, browserGone.signal)
      if (!opened) deny(socket, '502 Bad Gateway')
    })().catch((error) => {
      captureException(error, {
        tags: { component: 'artifact-stream-proxy', operation: 'connect' },
        extra: { routeAgentId: route.routeAgentId, artifactSlug: route.artifactSlug },
      })
      deny(socket, '502 Bad Gateway')
    })
  })
}
