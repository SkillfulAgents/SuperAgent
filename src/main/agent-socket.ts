/**
 * App WebSocket routes (browser live view, dashboard sockets, notifications), decided from the
 * request's URL and headers alone so any server that can accept a WebSocket can
 * serve them. `setupAgentSockets` wires them to a Node HTTP server's upgrades.
 */

import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import type { ServerType } from '@hono/node-server'
import { WebSocketServer, type RawData } from 'ws'
import { artifactSocket } from './artifact-stream-proxy'
import { browserStreamSocket } from './browser-stream-proxy'
import { notificationsSocket } from './notifications-socket'

export interface AgentSocketRequest {
  url: URL
  headers: Headers
  /** The peer's address, when the server sees it directly. */
  remoteAddress?: string
  /** Whether the connection to this server is TLS. */
  encrypted?: boolean
}

/** The accepted client socket. `ws` sockets fit it as they are. */
export interface AgentSocket {
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: RawData | string, options?: { binary: boolean }): void
  close(code?: number, reason?: string): void
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export type AgentSocketDecision =
  | { kind: 'refuse'; status: number }
  | {
      kind: 'accept'
      /** Subprotocol to answer with. */
      protocol?: string
      accept(client: AgentSocket): void
      /** The client left before it was accepted. */
      abandon(): void
    }

/** Null when the path is not this route's; otherwise how to answer the upgrade. */
export type AgentSocketRoute = (request: AgentSocketRequest) => Promise<AgentSocketDecision> | null

const ROUTES: AgentSocketRoute[] = [browserStreamSocket, artifactSocket, notificationsSocket]

/** How to answer a WebSocket upgrade, or null when the path is not an agent socket. */
export function handleAgentSocket(request: AgentSocketRequest): Promise<AgentSocketDecision> | null {
  for (const route of ROUTES) {
    const decision = route(request)
    if (decision) return decision
  }
  return null
}

const STATUS_TEXT: Record<number, string> = {
  403: 'Forbidden',
  404: 'Not Found',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
}

function refuse(socket: Duplex, status: number): void {
  if (socket.destroyed) return
  socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? ''}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

interface ProtocolAwareRequest extends IncomingMessage {
  _agentSocketProtocol?: string
}

const agentWss = new WebSocketServer({
  noServer: true,
  handleProtocols(protocols, request) {
    const selected = (request as ProtocolAwareRequest)._agentSocketProtocol
    return selected && protocols.has(selected) ? selected : false
  },
})

function socketRequest(request: IncomingMessage): AgentSocketRequest {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  return {
    // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- server request URLs always parse
    url: new URL(request.url || '', `http://${request.headers.host}`),
    headers,
    remoteAddress: request.socket.remoteAddress,
    encrypted: (request.socket as { encrypted?: boolean }).encrypted === true,
  }
}

export function setupAgentSockets(server: ServerType): void {
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pending = handleAgentSocket(socketRequest(request))
    // Not an agent socket: leave it for the other upgrade handlers.
    if (!pending) return

    pending.then((decision) => {
      if (decision.kind === 'refuse') return refuse(socket, decision.status)
      if (socket.destroyed) return decision.abandon()
      ;(request as ProtocolAwareRequest)._agentSocketProtocol = decision.protocol
      agentWss.handleUpgrade(request, socket, head, (client) => decision.accept(client))
    }, () => socket.destroy())
  })
}
