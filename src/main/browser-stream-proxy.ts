/**
 * Browser Stream WebSocket Proxy
 *
 * Handles WebSocket upgrade requests for /api/agents/:slug/browser/stream
 * and proxies them bidirectionally to the agent container's /browser/stream endpoint.
 */

import { WebSocket } from 'ws'
import { agentCatalog, agentRegistry } from '@shared/lib/agent-actor'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { getSettings } from '@shared/lib/config/settings'
import { captureException } from '@shared/lib/error-reporting'
import { authenticateAgentWebSocket } from './agent-websocket-auth'
import type { AgentSocket, AgentSocketDecision, AgentSocketRoute } from './agent-socket'
import { BrowserFrameRelay } from './browser-frame-relay'
import { openWebSocketTarget } from './websocket-opener'

export const browserStreamSocket: AgentSocketRoute = (request) => {
  const match = request.url.pathname.match(/^\/api\/agents\/([^/]+)\/browser\/stream$/)
  if (!match) return null

  return (async (): Promise<AgentSocketDecision> => {
    // The URL carries the display slug ({name}-{id}); resolve to the canonical id
    // before any ACL check or container lookup. This WS upgrade bypasses the Hono
    // /:id/* ResolveAgent middleware, so it must resolve itself.
    const agentSlug = await agentCatalog.resolve(match[1])
    if (!agentSlug) return { kind: 'refuse', status: 404 }
    // Viewer+ can watch; only 'user' and above may send input.
    if (!(await authenticateAgentWebSocket(request, agentSlug, 'viewer'))) return { kind: 'refuse', status: 403 }
    const canInput = await authenticateAgentWebSocket(request, agentSlug, 'user')
    return {
      kind: 'accept',
      accept: (ws: AgentSocket) => void relayBrowserStream(ws, agentSlug, canInput),
      abandon: () => {},
    }
  })()
}

async function relayBrowserStream(ws: AgentSocket, agentSlug: string, canInput: boolean): Promise<void> {
    try {
        // Cached status only — no runtime query
        const actor = agentRegistry.get(agentSlug)
        const target = await actor.container.webSocketTarget('/browser/stream')
        if (!target) {
          ws.close(1011, 'Agent container is not running')
          return
        }

        console.log(`[BrowserProxy] Connecting upstream to /browser/stream for agent ${agentSlug}`)
        const upstream = openWebSocketTarget(target)

        upstream.on('open', () => {
          console.log(`[BrowserProxy] Connected to container stream for agent ${agentSlug}`)
          const providerName = getSettings().app?.hostBrowserProvider ?? 'container'
          trackServerEvent('browser_opened', { using: providerName })
        })

        // Forward frames from container to client, preserving text/binary
        // framing. The relay holds screencast frames back while the client's
        // link is congested and sends the newest once it drains (see its doc).
        const relay = new BrowserFrameRelay(ws)
        upstream.on('message', (data, isBinary) => relay.forward(data as Buffer, isBinary))

        // Forward input events from client to container (only if user has 'user' role)
        ws.on('message', (data, isBinary) => {
          if (!canInput) return // Viewers can watch but not send input
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(data, { binary: isBinary })
          }
        })

        upstream.on('close', () => {
          trackServerEvent('browser_closed')
          if (ws.readyState === WebSocket.OPEN) {
            ws.close()
          }
        })

        ws.on('close', () => {
          relay.close()
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.close()
          }
        })

        upstream.on('error', (error) => {
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
