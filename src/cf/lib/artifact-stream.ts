/**
 * A dashboard's WebSocket in a Worker (Vite HMR and the dashboard's own sockets): what
 * artifact-stream-proxy.ts does for the Node server. The upgrade arrives here instead of at an HTTP
 * server, and the container's socket is reached as the browser view reaches it (browser-stream.ts).
 */
import type { IncomingMessage } from 'node:http'
import type { WorkerWebSocket } from 'cloudflare:workers'
import { agentCatalog, agentRegistry } from '@shared/lib/agent-actor'
import { authenticateAgentWebSocket } from '../../main/agent-websocket-auth'
import { artifactWebSocketForwardHeaders, parseArtifactWebSocketRoute } from '../../main/artifact-stream-proxy'
import { agentContainers } from '../cloudflare-container-control'
import { relay } from './browser-stream'
import type { Env } from '../index'

export async function serveArtifactStream(request: Request, env: Env): Promise<Response> {
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- a request's URL always parses
  const url = new URL(request.url)
  const route = parseArtifactWebSocketRoute(url.pathname)
  if (!route) return new Response(null, { status: 404 })
  const agentSlug = await agentCatalog.resolve(route.routeAgentId)
  if (!agentSlug) return new Response(null, { status: 404 })
  // The client address is already in x-forwarded-for (withClientAddress), so the socket gives none.
  const nodeRequest = {
    headers: Object.fromEntries(request.headers),
    socket: { encrypted: url.protocol === 'https:' },
  } as unknown as IncomingMessage
  if (!(await authenticateAgentWebSocket(nodeRequest, agentSlug, 'viewer'))) return new Response(null, { status: 403 })

  const protocols = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((protocol) => protocol.trim()).filter(Boolean)
  const target = await agentRegistry.get(agentSlug).container.webSocketTarget(route.containerPath, {
    search: url.search,
    protocols,
    headers: artifactWebSocketForwardHeaders(nodeRequest, route.publicBasePath),
  })
  if (!target) return new Response(null, { status: 503 })
  const offered = [target.protocols ?? []].flat()
  const upstreamResponse = await agentContainers(env.AGENT, env.VERSION?.timestamp).fetch(target.url.replace(/^ws/, 'http'), {
    headers: { ...target.headers, Upgrade: 'websocket', ...(offered.length ? { 'Sec-WebSocket-Protocol': offered.join(', ') } : {}) },
  })
  const upstream = (upstreamResponse as Response & { webSocket?: WorkerWebSocket | null }).webSocket
  if (!upstream) return new Response(null, { status: 502 })

  const [client, server] = Object.values(new WebSocketPair()) as [WorkerWebSocket, WorkerWebSocket]
  upstream.accept()
  server.accept()
  const failBoth = () => {
    closePeer(server)
    closePeer(upstream)
  }
  relay(server, upstream, () => true, failBoth)
  relay(upstream, server, () => true, failBoth)
  // Each side closes with the other's code, as the Node proxy does, so a dashboard sees why its socket went.
  server.addEventListener('close', (event) => closePeer(upstream, event as CloseEvent))
  upstream.addEventListener('close', (event) => closePeer(server, event as CloseEvent))
  server.addEventListener('error', failBoth)
  upstream.addEventListener('error', failBoth)
  const protocol = upstreamResponse.headers.get('Sec-WebSocket-Protocol')
  return new Response(null, { status: 101, webSocket: client, headers: protocol ? { 'Sec-WebSocket-Protocol': protocol } : undefined } as ResponseInit)
}

/** A code a peer may not send itself (1005, 1006, 1015) or none at all becomes 1011, as in artifact-stream-proxy.ts. */
function closePeer(peer: WorkerWebSocket, event?: CloseEvent): void {
  const code = event && (event.code === 1000 || event.code >= 3000) ? event.code : 1011
  try {
    peer.close(code, event?.reason?.slice(0, 120))
  } catch {
    // already closed
  }
}
