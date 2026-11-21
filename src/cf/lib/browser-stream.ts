/**
 * The live browser view in a Worker: the upgrade arrives here instead of at an HTTP server, and the
 * shared steps of browser-stream-proxy.ts do the rest. The container's socket is opened through the
 * installed containers (openContainerWebSocket).
 */
import type { ExecutionContext, WorkerWebSocket } from 'cloudflare:workers'
import { openContainerWebSocket } from '@shared/lib/container/cloudflare-container-runtime'
import { admitBrowserStream, serveBrowserStream as serveStream } from '../../main/browser-stream-proxy'
import { WebSocket } from '../build/shims/ws'

export async function serveBrowserStream(request: Request, slugInUrl: string, ctx: ExecutionContext): Promise<Response> {
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- a request's URL always parses
  const admitted = await admitBrowserStream(slugInUrl, new URL(request.url), { headers: Object.fromEntries(request.headers) })
  if ('status' in admitted) return new Response(null, { status: admitted.status })
  const [client, server] = Object.values(new WebSocketPair()) as [WorkerWebSocket, WorkerWebSocket]
  // The container's socket opens after the answer, as on the Node server.
  ctx.waitUntil(serveStream(WebSocket.accepted(server), admitted, openContainerWebSocket))
  return new Response(null, { status: 101, webSocket: client } as ResponseInit)
}
