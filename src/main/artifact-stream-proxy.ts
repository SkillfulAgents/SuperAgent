/** WebSocket half of the dashboard artifact reverse proxy (Vite HMR + app sockets). */

import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import type { ServerType } from '@hono/node-server'
import { WebSocketServer, WebSocket } from 'ws'

import { containerManager } from '@shared/lib/container/container-manager'
import { captureException } from '@shared/lib/error-reporting'
import { resolveAgentId } from '@shared/lib/utils/file-storage'
import { authenticateAgentWebSocket } from './agent-websocket-auth'

interface ArtifactWebSocketRoute {
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

function requestProtocol(request: IncomingMessage): string {
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
  return (request.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'
}

export function artifactWebSocketForwardHeaders(
  request: IncomingMessage,
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
  const remoteAddress = request.socket.remoteAddress
  if (remoteAddress) {
    const forwardedFor = request.headers['x-forwarded-for']
    const existing = Array.isArray(forwardedFor) ? forwardedFor.join(', ') : forwardedFor
    headers['x-forwarded-for'] = existing ? `${existing}, ${remoteAddress}` : remoteAddress
  }
  return headers
}

function requestedProtocols(request: IncomingMessage): string[] {
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

function bridge(client: WebSocket, upstream: WebSocket, route: ArtifactWebSocketRoute): void {
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

export function setupArtifactStreamProxy(server: ServerType): void {
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- server request URLs always parse
    const url = new URL(request.url || '', `http://${request.headers.host}`)
    const route = parseArtifactWebSocketRoute(url.pathname)
    if (!route) return

    resolveAgentId(route.routeAgentId)
      .then(async (agentSlug) => {
        if (!agentSlug) return deny(socket, '404 Not Found')
        if (!(await authenticateAgentWebSocket(request, agentSlug, 'viewer'))) {
          return deny(socket, '403 Forbidden')
        }

        const client = containerManager.getClient(agentSlug)
        const info = containerManager.getCachedInfo(agentSlug)
        if (info.status !== 'running' || !info.port) return deny(socket, '503 Service Unavailable')

        const protocols = requestedProtocols(request)
        const upstream = new WebSocket(
          `${client.getWebSocketBaseUrl(info.port)}${route.containerPath}${url.search}`,
          protocols,
          {
            headers: {
              ...artifactWebSocketForwardHeaders(request, route.publicBasePath),
              ...client.getHostAuthHeaders(),
            },
          },
        )

        let settled = false
        const fail = (error?: unknown) => {
          if (settled) return
          settled = true
          upstream.terminate()
          if (error) {
            captureException(error, {
              tags: { component: 'artifact-stream-proxy', operation: 'connect' },
              extra: { agentSlug, artifactSlug: route.artifactSlug },
            })
          }
          deny(socket, '502 Bad Gateway')
        }

        socket.once('close', () => {
          if (!settled) upstream.terminate()
        })
        upstream.once('unexpected-response', (_req, response) => {
          response.resume()
          fail(new Error(`Dashboard WebSocket refused upgrade (${response.statusCode})`))
        })
        upstream.once('error', fail)
        upstream.once('open', () => {
          if (settled || socket.destroyed) {
            upstream.terminate()
            return
          }
          settled = true
          ;(request as ProtocolAwareRequest)._gamutDashboardProtocol = upstream.protocol || undefined
          artifactWss.handleUpgrade(request, socket, head, (browser) => {
            bridge(browser, upstream, route)
          })
        })
      })
      .catch((error) => {
        captureException(error, {
          tags: { component: 'artifact-stream-proxy', operation: 'authorize' },
          extra: { routeAgentId: route.routeAgentId, artifactSlug: route.artifactSlug },
        })
        deny(socket, '502 Bad Gateway')
      })
  })
}
