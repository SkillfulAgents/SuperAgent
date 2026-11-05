/** WebSocket half of the dashboard artifact reverse proxy (Vite HMR + app sockets). */

import { WebSocket } from 'ws'

import { agentCatalog, agentRegistry } from '@shared/lib/agent-actor'
import { captureException } from '@shared/lib/error-reporting'
import type { AgentSocket, AgentSocketDecision, AgentSocketRequest, AgentSocketRoute } from './agent-socket'
import { authenticateAgentWebSocket } from './agent-websocket-auth'
import { openWebSocketTarget } from './websocket-opener'

interface ArtifactWebSocketRoute {
  routeAgentId: string
  artifactSlug: string
  publicBasePath: string
  containerPath: string
}

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

function requestProtocol(request: AgentSocketRequest): string {
  const forwarded = request.headers.get('x-forwarded-proto')
  if (forwarded) return forwarded.split(',')[0].trim()

  const origin = request.headers.get('origin')
  if (origin) {
    try {
      return new URL(origin).protocol.replace(/:$/, '')
    } catch {
      // Fall through to socket encryption state.
    }
  }
  return request.encrypted ? 'https' : 'http'
}

export function artifactWebSocketForwardHeaders(
  request: AgentSocketRequest,
  publicBasePath: string,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of request.headers) {
    if (SKIP_UPSTREAM_HEADERS.has(name)) continue
    headers[name] = value
  }
  headers['x-forwarded-prefix'] = publicBasePath.slice(0, -1)
  headers['x-forwarded-host'] = request.headers.get('x-forwarded-host')
    || request.headers.get('host')
    || ''
  headers['x-forwarded-proto'] = requestProtocol(request)
  const remoteAddress = request.remoteAddress
  if (remoteAddress) {
    const existing = request.headers.get('x-forwarded-for')
    headers['x-forwarded-for'] = existing ? `${existing}, ${remoteAddress}` : remoteAddress
  }
  return headers
}

function requestedProtocols(request: AgentSocketRequest): string[] {
  const value = request.headers.get('sec-websocket-protocol')
  return value ? value.split(',').map((protocol) => protocol.trim()).filter(Boolean) : []
}

function closePeer(peer: AgentSocket, code?: number, reason?: Buffer): void {
  if (peer.readyState !== WebSocket.OPEN) return
  const relayCode = code === 1000 || (code !== undefined && code >= 3000) ? code : 1011
  peer.close(relayCode, reason?.toString().slice(0, 120))
}

function bridge(client: AgentSocket, upstream: WebSocket, route: ArtifactWebSocketRoute): void {
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

export const artifactSocket: AgentSocketRoute = (request) => {
  const route = parseArtifactWebSocketRoute(request.url.pathname)
  if (!route) return null
  return connectArtifactSocket(request, route)
}

async function connectArtifactSocket(
  request: AgentSocketRequest,
  route: ArtifactWebSocketRoute,
): Promise<AgentSocketDecision> {
  let target
  try {
    const agentSlug = await agentCatalog.resolve(route.routeAgentId)
    if (!agentSlug) return { kind: 'refuse', status: 404 }
    if (!(await authenticateAgentWebSocket(request, agentSlug, 'viewer'))) return { kind: 'refuse', status: 403 }

    // Forwarded headers first; the actor adds the container's auth headers after them.
    target = await agentRegistry.get(agentSlug).container.webSocketTarget(route.containerPath, {
      search: request.url.search,
      protocols: requestedProtocols(request),
      headers: artifactWebSocketForwardHeaders(request, route.publicBasePath),
    })
  } catch (error) {
    captureException(error, {
      tags: { component: 'artifact-stream-proxy', operation: 'authorize' },
      extra: { routeAgentId: route.routeAgentId, artifactSlug: route.artifactSlug },
    })
    return { kind: 'refuse', status: 502 }
  }
  if (!target) return { kind: 'refuse', status: 503 }

  // The dashboard's subprotocol answer is only known once its upgrade succeeds,
  // so the client is accepted after the upstream opens.
  const upstream = openWebSocketTarget(target)
  try {
    await new Promise<void>((resolve, reject) => {
      upstream.once('unexpected-response', (_req, response) => {
        response.resume()
        reject(new Error(`Dashboard WebSocket refused upgrade (${response.statusCode})`))
      })
      upstream.once('error', reject)
      upstream.once('open', () => resolve())
    })
  } catch (error) {
    upstream.terminate()
    captureException(error, {
      tags: { component: 'artifact-stream-proxy', operation: 'connect' },
      extra: { routeAgentId: route.routeAgentId, artifactSlug: route.artifactSlug },
    })
    return { kind: 'refuse', status: 502 }
  }

  return {
    kind: 'accept',
    protocol: upstream.protocol || undefined,
    accept: (client) => bridge(client, upstream, route),
    abandon: () => upstream.terminate(),
  }
}
