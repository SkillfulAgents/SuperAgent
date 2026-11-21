/**
 * A dashboard's WebSocket in a Worker (Vite HMR and the dashboard's own sockets): the upgrade arrives
 * here instead of at an HTTP server, and the shared steps of artifact-stream-proxy.ts do the rest.
 */
import type { WorkerWebSocket } from 'cloudflare:workers'
import { openContainerWebSocket } from '@shared/lib/container/cloudflare-container-runtime'
import { admitArtifactStream, artifactUpstreamOpened, bridgeArtifactStream, parseArtifactWebSocketRoute } from '../../main/artifact-stream-proxy'
import { WebSocket } from '../build/shims/ws'

export async function serveArtifactStream(request: Request): Promise<Response> {
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- a request's URL always parses
  const url = new URL(request.url)
  const route = parseArtifactWebSocketRoute(url.pathname)
  if (!route) return new Response(null, { status: 404 })
  // The client address is already in x-forwarded-for (withClientAddress), so the socket gives none.
  const admitted = await admitArtifactStream(route, url.search, {
    headers: Object.fromEntries(request.headers),
    socket: { encrypted: url.protocol === 'https:' },
  })
  if ('status' in admitted) return new Response(null, { status: admitted.status })
  const upstream = openContainerWebSocket(admitted.target)
  const [client, server] = Object.values(new WebSocketPair()) as [WorkerWebSocket, WorkerWebSocket]
  const opened = await artifactUpstreamOpened(upstream, admitted, () => bridgeArtifactStream(WebSocket.accepted(server), upstream, route))
  if (!opened) return new Response(null, { status: 502 })
  const headers = upstream.protocol ? { 'Sec-WebSocket-Protocol': upstream.protocol } : undefined
  return new Response(null, { status: 101, webSocket: client, headers } as ResponseInit)
}
