/**
 * The live browser view in a Worker: what browser-stream-proxy.ts does for the Node server. The
 * upgrade arrives here instead of at an HTTP server, and the container's socket comes from the
 * agent's object (cloudflare-agent.ts bridges it), reached like any other container call.
 */
import type { IncomingMessage } from 'node:http'
import type { WorkerWebSocket } from 'cloudflare:workers'
import { agentCatalog, agentRegistry } from '@shared/lib/agent-actor'
import { authenticateAgentWebSocket } from '../../main/agent-websocket-auth'

/** A real viewport command is tiny, so a view-only client cannot make the Worker parse anything large. */
const MAX_VIEWPORT_COMMAND_BYTES = 256

export async function serveBrowserStream(request: Request, slugInUrl: string): Promise<Response> {
  const agentSlug = await agentCatalog.resolve(slugInUrl)
  if (!agentSlug) return new Response(null, { status: 404 })
  // In auth mode the helper reads only the request's headers.
  const nodeRequest = { headers: Object.fromEntries(request.headers) } as unknown as IncomingMessage
  if (!(await authenticateAgentWebSocket(nodeRequest, agentSlug, 'viewer'))) return new Response(null, { status: 403 })
  const canInput = await authenticateAgentWebSocket(nodeRequest, agentSlug, 'user')

  const width = new URL(request.url).searchParams.get('width')
  const target = await agentRegistry.get(agentSlug).container.webSocketTarget('/browser/stream', {
    search: width && /^\d+$/.test(width) ? `?width=${width}` : '',
  })
  if (!target) return new Response('Agent container is not running', { status: 503 })
  const upstreamResponse = await fetch(target.url.replace(/^ws/, 'http'), { headers: { ...target.headers, Upgrade: 'websocket' } })
  const upstream = (upstreamResponse as Response & { webSocket?: WorkerWebSocket | null }).webSocket
  if (!upstream) return new Response('The browser stream did not open', { status: 502 })

  const [client, server] = Object.values(new WebSocketPair()) as [WorkerWebSocket, WorkerWebSocket]
  upstream.accept()
  server.accept()
  // Viewers can watch but not send input; their canvas width only sizes the frames.
  relay(server, upstream, (data) => canInput || (typeof data === 'string' && isViewportCommand(data)), () => closeBoth())
  relay(upstream, server, () => true, () => closeBoth())
  const closeBoth = () => {
    for (const socket of [server, upstream]) {
      try { socket.close() } catch { /* already closed */ }
    }
  }
  for (const socket of [server, upstream]) {
    socket.addEventListener('close', closeBoth)
    socket.addEventListener('error', closeBoth)
  }
  return new Response(null, { status: 101, webSocket: client } as ResponseInit)
}

/** Forwards in order; a binary message can arrive as a Blob, which send() would turn into "[object Blob]". */
function relay(from: WorkerWebSocket, to: WorkerWebSocket, allow: (data: string | ArrayBuffer | Blob) => boolean, fail: () => void): void {
  let sending: Promise<void> = Promise.resolve()
  from.addEventListener('message', (event) => {
    const data = event.data as string | ArrayBuffer | Blob
    if (!allow(data)) return
    sending = sending.then(async () => {
      to.send(data instanceof Blob ? await data.arrayBuffer() : data)
    }).catch(fail)
  })
}

function isViewportCommand(data: string): boolean {
  if (data.length > MAX_VIEWPORT_COMMAND_BYTES) return false
  try {
    return (JSON.parse(data) as { type?: unknown } | null)?.type === 'viewport'
  } catch {
    return false
  }
}
