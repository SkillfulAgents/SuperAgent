import { EventEmitter, once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ receiveScreenFrame: vi.fn(async () => {}), captureException: vi.fn(), verifyParticipantToken: vi.fn() }))
vi.mock('@shared/lib/meeting-integrations/bot-events', () => ({ meetingScreenFrameReceiver: async () => mocks.receiveScreenFrame }))
vi.mock('@shared/lib/meeting-integrations/store', () => ({ verifyParticipantToken: mocks.verifyParticipantToken }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: mocks.captureException }))

import { receiveMeetingFrames, setupMeetingFramesSocket } from './meeting-frames-socket'

const meeting = { id: 'meeting-1', integrationId: 'integration-1', agentSlug: 'ada', status: 'in_call' }
let server: Server
let url: string
const clients = new Set<WebSocket>()

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.verifyParticipantToken.mockResolvedValue(meeting)
  server = createServer()
  setupMeetingFramesSocket(server)
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/meeting-participant/${meeting.id}/frames/?token=token`
})

afterEach(async () => {
  await Promise.all([...clients].map(async client => {
    if (client.readyState === WebSocket.CLOSED) return
    const closed = once(client, 'close')
    client.terminate()
    await closed
  }))
  clients.clear()
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

async function connect(): Promise<WebSocket> {
  const client = new WebSocket(url)
  clients.add(client)
  await once(client, 'open')
  return client
}

describe('meeting frames socket', () => {
  it('forwards valid JSON frames and ignores binary frames and malformed JSON', async () => {
    const client = await connect()
    client.send(Buffer.from('binary frame'))
    client.send('invalid JSON')
    client.send(JSON.stringify({ event: 'video_separate_png.data' }))
    await vi.waitFor(() => expect(mocks.receiveScreenFrame).toHaveBeenCalledOnce())
    expect(mocks.receiveScreenFrame).toHaveBeenCalledWith({ event: 'video_separate_png.data' })
    expect(mocks.captureException).not.toHaveBeenCalled()
  })

  it.each([
    ['oversized message', () => 'x'.repeat(4 * 1024 * 1024 + 1), 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'],
    ['invalid UTF-8 text', () => Buffer.from([0xff]), 'WS_ERR_INVALID_UTF8'],
  ])('contains an %s error and continues serving other connections', async (_label, payload, code) => {
    const client = await connect()
    const healthyClient = await connect()
    const closed = once(client, 'close')
    client.send(payload(), { binary: false })
    await closed
    expect(mocks.captureException).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code }), {
      tags: { component: 'meeting-frames-socket', operation: 'receive' },
      extra: { meetingId: meeting.id },
      level: 'warning',
    })
    expect(mocks.receiveScreenFrame).not.toHaveBeenCalled()
    healthyClient.send(JSON.stringify({ event: 'video_separate_png.data' }))
    await vi.waitFor(() => expect(mocks.receiveScreenFrame).toHaveBeenCalledOnce())
    expect(healthyClient.readyState).toBe(WebSocket.OPEN)
  })

  it('holds a socket that delivers text as strings to the byte limit', () => {
    // A runtime that accepts sockets another way (a Worker's WebSocketPair) delivers text as a string, with no maxPayload.
    const socket = Object.assign(new EventEmitter(), { ping: vi.fn(), close: vi.fn(), terminate: vi.fn() })
    receiveMeetingFrames(socket as unknown as WebSocket, meeting as never, mocks.receiveScreenFrame)

    socket.emit('message', JSON.stringify({ event: 'video_separate_png.data' }), false)
    expect(mocks.receiveScreenFrame).toHaveBeenCalledWith({ event: 'video_separate_png.data' })

    // 1.5 Mi characters of 3 bytes each: under the limit in UTF-16 units, over it in bytes.
    socket.emit('message', '\u20ac'.repeat(1.5 * 1024 * 1024), false)
    expect(socket.close).toHaveBeenCalledWith(1009, 'Message too big')
    socket.emit('close')
  })
})
