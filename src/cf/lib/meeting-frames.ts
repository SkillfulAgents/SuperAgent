/**
 * The meeting frames WebSocket in a Worker: what meeting-frames-socket.ts does for the Node server.
 * The meeting bot host streams the frames of shared screens here; the meeting's participant token,
 * checked before the upgrade, is the credential.
 */
import type { WorkerWebSocket } from 'cloudflare:workers'
import { captureException } from '@shared/lib/error-reporting'
import { meetingScreenFrameReceiver } from '@shared/lib/meeting-integrations/bot-events'
import { isTerminalMeetingStatus } from '@shared/lib/meeting-integrations/schemas'
import { verifyParticipantToken } from '@shared/lib/meeting-integrations/store'

/** As meeting-frames-socket.ts: a 1280x720 PNG is about 200 KB once base64 and JSON wrap it. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024

export async function serveMeetingFrames(request: Request, meetingIdInUrl: string): Promise<Response> {
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- a request's URL always parses
  const token = new URL(request.url).searchParams.get('token')
  if (!token) return new Response(null, { status: 401 })
  let meetingId: string
  try {
    meetingId = decodeURIComponent(meetingIdInUrl)
  } catch {
    return new Response(null, { status: 404 })
  }
  const meeting = await verifyParticipantToken(meetingId, token)
  if (!meeting) return new Response(null, { status: 404 })
  if (isTerminalMeetingStatus(meeting.status)) return new Response(null, { status: 410 })
  const receive = await meetingScreenFrameReceiver(meeting)
  if (!receive) return new Response(null, { status: 404 })

  const [client, server] = Object.values(new WebSocketPair()) as [WorkerWebSocket, WorkerWebSocket]
  server.accept()
  server.addEventListener('message', (event) => {
    const data = event.data
    if (typeof data !== 'string') return
    if (data.length > MAX_MESSAGE_BYTES) {
      server.close(1009, 'Message too big')
      return
    }
    let message: unknown
    try {
      message = JSON.parse(data)
    } catch {
      return
    }
    receive(message).catch((error) => captureException(error, {
      tags: { component: 'meeting-frames-socket', operation: 'save-frame' },
      extra: { meetingId: meeting.id },
    }))
  })
  server.addEventListener('error', (event) => {
    captureException((event as ErrorEvent).error ?? new Error('Meeting frames socket error'), {
      tags: { component: 'meeting-frames-socket', operation: 'receive' },
      extra: { meetingId: meeting.id },
      level: 'warning',
    })
  })
  return new Response(null, { status: 101, webSocket: client } as ResponseInit)
}
