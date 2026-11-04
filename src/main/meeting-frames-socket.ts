/**
 * Meeting frames WebSocket
 *
 * The meeting bot host streams frames of shared screens to
 * /api/meeting-participant/:meetingId/frames/?token=… over a websocket (the
 * bot host can deliver frames no other way). The meeting's one-time
 * participant token, checked before the upgrade, is the credential, as for
 * the HTTP events callback beside it.
 */

import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import type { ServerType } from '@hono/node-server'
import { WebSocketServer, type WebSocket } from 'ws'
import { agentIntegrationManager } from '@shared/lib/agent-integrations/agent-integration-manager'
import { MeetingAgentIntegration } from '@shared/lib/meeting-integrations/meeting-agent-integration'
import { isTerminalMeetingStatus } from '@shared/lib/meeting-integrations/schemas'
import { verifyParticipantToken, type MeetingRecord } from '@shared/lib/meeting-integrations/store'

const FRAMES_PATH = /^\/api\/meeting-participant\/([^/]+)\/frames\/?$/
/** A 1280x720 PNG is about 150 KB, ~200 KB once base64 and JSON wrap it. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
/** Proxies in front of the host close idle sockets; nothing flows while nobody shares. */
const PING_MS = 30_000

const framesWss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })

function deny(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`)
  socket.destroy()
}

export function setupMeetingFramesSocket(server: ServerType): void {
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- request.url from the HTTP server always parses
    const url = new URL(request.url || '', `http://${request.headers.host}`)
    const match = url.pathname.match(FRAMES_PATH)
    if (!match) return

    const token = url.searchParams.get('token')
    if (!token) return deny(socket, '401 Unauthorized')
    let meetingId: string
    try { meetingId = decodeURIComponent(match[1]) } catch { return deny(socket, '404 Not Found') }
    verifyParticipantToken(meetingId, token).then((meeting) => {
      if (!meeting) return deny(socket, '404 Not Found')
      if (isTerminalMeetingStatus(meeting.status)) return deny(socket, '410 Gone')
      framesWss.handleUpgrade(request, socket, head, (ws) => receiveFrames(ws, meeting))
    }).catch(() => socket.destroy())
  })
}

function receiveFrames(ws: WebSocket, meeting: MeetingRecord): void {
  const ping = setInterval(() => ws.ping(), PING_MS)
  ws.on('close', () => clearInterval(ping))
  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    const connector = agentIntegrationManager.getConnector(meeting.integrationId)
    if (!(connector instanceof MeetingAgentIntegration)) return
    let message: unknown
    try { message = JSON.parse(data.toString()) } catch { return }
    connector.receiveScreenFrame(meeting, message)
  })
}
