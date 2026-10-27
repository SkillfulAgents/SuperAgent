/**
 * The global notifications stream for a browser tab, over a WebSocket at
 * `/api/notifications/socket`. It carries the same events as the SSE route.
 *
 * The tab sends `ping` every 30 seconds and gets `pong` back. A server that
 * holds many idle sockets can then answer it without running app code.
 */

import { WebSocket } from 'ws'
import { openNotificationsFeed } from '../api/lib/notifications-feed'
import type { AgentSocket, AgentSocketRoute } from './agent-socket'
import { authenticateUserWebSocket } from './agent-websocket-auth'

export const notificationsSocket: AgentSocketRoute = (request) => {
  if (request.url.pathname !== '/api/notifications/socket') return null
  return authenticateUserWebSocket(request).then((user) => user === null
    ? { kind: 'refuse', status: 403 }
    : { kind: 'accept', accept: (ws: AgentSocket) => streamNotifications(ws, user), abandon: () => {} })
}

function streamNotifications(ws: AgentSocket, user: { id: string } | undefined): void {
  const close = openNotificationsFeed({
    user,
    deliver: (event) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
    },
    onLoadError: () => ws.close(1011, 'Access check failed'),
  })
  ws.on('message', (data) => {
    if (data.toString() === 'ping' && ws.readyState === WebSocket.OPEN) ws.send('pong')
  })
  ws.on('close', close)
  ws.on('error', (error) => console.error('[NotificationsSocket] Socket error:', error))
}
