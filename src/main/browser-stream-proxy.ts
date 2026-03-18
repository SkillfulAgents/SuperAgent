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
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { getSettings } from '@shared/lib/config/settings'
import { isAuthMode } from '@shared/lib/auth/mode'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import { and, eq } from 'drizzle-orm'

const browserWss = new WebSocketServer({ noServer: true })

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

type AgentRole = 'owner' | 'user' | 'viewer'
const ROLE_HIERARCHY: Record<AgentRole, number> = { viewer: 0, user: 1, owner: 2 }

async function authenticateWs(
  request: IncomingMessage,
  agentSlug: string,
  minRole: AgentRole,
): Promise<boolean> {
  if (!isAuthMode()) {
    const addr = request.socket?.remoteAddress
    if (!addr || !LOCALHOST_ADDRS.has(addr)) return false
    return true
  }

  try {
    // Lazy import to avoid pulling in better-auth ESM at startup
    const { getAuth } = await import('@shared/lib/auth/index')
    const auth = getAuth()

    // Convert raw headers to Headers for Better Auth
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) {
      if (value) headers.set(key, Array.isArray(value) ? value[0] : value)
    }

    const session = await auth.api.getSession({ headers })
    if (!session?.user) return false

    // Check agent-level ACL
    const [row] = await db
      .select({ role: agentAcl.role })
      .from(agentAcl)
      .where(and(eq(agentAcl.userId, session.user.id), eq(agentAcl.agentSlug, agentSlug)))
      .limit(1)

    if (!row) return false
    const userRole = row.role as AgentRole
    return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[minRole]
  } catch (error) {
    console.error('[BrowserProxy] Auth check failed:', error)
    return false
  }
}

export function setupBrowserStreamProxy(server: ServerType): void {
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`)
    const match = url.pathname.match(/^\/api\/agents\/([^/]+)\/browser\/stream$/)

    if (!match) {
      // Not a browser stream request — don't touch it, let other handlers handle it
      return
    }

    const agentSlug = match[1]

    // Authenticate before upgrading — viewer+ can watch, but input is filtered per-role below
    authenticateWs(request, agentSlug, 'viewer').then((allowed) => {
      if (!allowed) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }

      // Check if user has 'user' role (can send input) — stash on the request object
      authenticateWs(request, agentSlug, 'user').then((canInput) => {
        ;(request as any)._canInput = canInput
        browserWss.handleUpgrade(request, socket, head, (ws) => {
          browserWss.emit('connection', ws, request)
        })
      })
    })
  })

  browserWss.on('connection', async (ws: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`)
    const match = url.pathname.match(/^\/api\/agents\/([^/]+)\/browser\/stream$/)
    if (!match) { ws.close(1011, 'Invalid path'); return }

    const agentSlug = match[1]
    const canInput = (request as any)._canInput === true

    try {
        // Ensure client exists (creates if needed) and get cached status
        containerManager.getClient(agentSlug)
        const info = containerManager.getCachedInfo(agentSlug)

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
          const providerName = getSettings().app?.hostBrowserProvider ?? 'container'
          trackServerEvent('browser_opened', { using: providerName })
        })

        // Forward frames from container to client
        // Preserve text/binary framing so JSON text frames aren't converted to binary
        upstream.on('message', (data, isBinary) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data, { binary: isBinary })
          }
        })

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
}
