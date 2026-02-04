/**
 * Browser Stream WebSocket Proxy
 *
 * Handles WebSocket upgrade requests for /api/agents/:slug/browser/stream
 * and proxies them bidirectionally to the agent container's /browser/stream endpoint.
 */

import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import type { ServerType } from '@hono/node-server'
import { WebSocketServer, WebSocket } from 'ws'
import { containerManager } from '@shared/lib/container/container-manager'

const browserWss = new WebSocketServer({ noServer: true })

export function setupBrowserStreamProxy(server: ServerType): void {
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`)
    const match = url.pathname.match(/^\/api\/agents\/([^/]+)\/browser\/stream$/)

    if (!match) {
      // Not a browser stream request — don't touch it, let other handlers handle it
      return
    }

    const agentSlug = match[1]

    browserWss.handleUpgrade(request, socket, head, async (ws) => {
      try {
        const client = containerManager.getClient(agentSlug)
        const info = await client.getInfo()

        if (info.status !== 'running' || !info.port) {
          ws.close(1011, 'Agent container is not running')
          return
        }

        // Connect to the container's browser stream WebSocket
        const wsUrl = `ws://localhost:${info.port}/browser/stream`
        console.log(`[BrowserProxy] Connecting upstream to: ${wsUrl}`)
        const upstream = new WebSocket(wsUrl)

        upstream.on('open', () => {
          console.log(`[BrowserProxy] Connected to container stream for agent ${agentSlug}`)
        })

        // Forward frames from container to client
        // Preserve text/binary framing so JSON text frames aren't converted to binary
        upstream.on('message', (data, isBinary) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data, { binary: isBinary })
          }
        })

        // Forward input events from client to container
        ws.on('message', (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(data, { binary: isBinary })
          }
        })

        upstream.on('close', () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close()
          }
        })

        ws.on('close', () => {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.close()
          }
        })

        upstream.on('error', (error) => {
          console.error(`[BrowserProxy] Upstream error for agent ${agentSlug}:`, error)
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1011, 'Upstream connection error')
          }
        })

        ws.on('error', (error) => {
          console.error(`[BrowserProxy] Client error for agent ${agentSlug}:`, error)
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.close()
          }
        })
      } catch (error) {
        console.error(`[BrowserProxy] Failed to set up proxy for agent ${agentSlug}:`, error)
        ws.close(1011, 'Failed to connect to browser stream')
      }
    })
  })
}
