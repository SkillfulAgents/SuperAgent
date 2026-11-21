/**
 * The meeting frames WebSocket in a Worker: the upgrade arrives here instead of at an HTTP server,
 * and the shared steps of meeting-frames-socket.ts do the rest.
 */
import type { WorkerWebSocket } from 'cloudflare:workers'
import { admitMeetingFrames, receiveMeetingFrames } from '../../main/meeting-frames-socket'
import { WebSocket } from '../build/shims/ws'

export async function serveMeetingFrames(request: Request, meetingIdInUrl: string): Promise<Response> {
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- a request's URL always parses
  const admitted = await admitMeetingFrames(meetingIdInUrl, new URL(request.url).searchParams.get('token'))
  if ('status' in admitted) return new Response(null, { status: admitted.status })
  const [client, server] = Object.values(new WebSocketPair()) as [WorkerWebSocket, WorkerWebSocket]
  receiveMeetingFrames(WebSocket.accepted(server), admitted.meeting, admitted.receive)
  return new Response(null, { status: 101, webSocket: client } as ResponseInit)
}
