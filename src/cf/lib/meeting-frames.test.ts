import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  meeting: null as null | { id: string; status: string },
  receive: vi.fn(async (_message: unknown) => {}),
  verify: vi.fn(),
}))
vi.mock('@shared/lib/meeting-integrations/store', () => ({ verifyParticipantToken: deps.verify }))
vi.mock('@shared/lib/meeting-integrations/bot-events', () => ({ meetingScreenFrameReceiver: async () => deps.receive }))

import { serveMeetingFrames } from './meeting-frames'

type Listener = (event: { data?: unknown }) => void

function socket() {
  const listeners = new Map<string, Listener>()
  const closed: Array<[number | undefined, string | undefined]> = []
  return {
    closed,
    accept: () => {},
    close: (code?: number, reason?: string) => closed.push([code, reason]),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    deliver: (data: unknown) => listeners.get('message')!({ data }),
    closeFromPeer: () => listeners.get('close')!({ code: 1000, reason: '' } as never),
  }
}

const upgrade = (search = '?token=participant-token') =>
  new Request(`https://org.example.com/api/meeting-participant/meeting-1/frames${search}`, { headers: { Upgrade: 'websocket' } })

describe('serveMeetingFrames', () => {
  let server: ReturnType<typeof socket>
  const NodeResponse = globalThis.Response

  beforeEach(() => {
    server = socket()
    deps.receive.mockClear()
    deps.verify.mockReset().mockImplementation(async (id: string, token: string) => (token === 'participant-token' ? { id, status: 'in_call' } : null))
    vi.stubGlobal('WebSocketPair', class {
      0 = socket()
      1 = server
    })
  })

  afterEach(() => {
    vi.stubGlobal('Response', NodeResponse)
  })

  it('refuses a socket without the participant token, or with a wrong one', async () => {
    expect((await serveMeetingFrames(upgrade(''), 'meeting-1')).status).toBe(401)
    expect((await serveMeetingFrames(upgrade('?token=guess'), 'meeting-1')).status).toBe(404)
  })

  it('refuses a meeting that has ended', async () => {
    deps.verify.mockImplementation(async (id: string) => ({ id, status: 'ended' }))

    expect((await serveMeetingFrames(upgrade(), 'meeting-1')).status).toBe(410)
  })

  it('hands each JSON frame to the receiver, and skips binary and unreadable messages', async () => {
    vi.stubGlobal('Response', class {
      constructor(_body: unknown, readonly init: { status: number }) {}
    })
    const response = (await serveMeetingFrames(upgrade(), 'meeting-1')) as unknown as { init: { status: number } }
    expect(response.init.status).toBe(101)

    server.deliver(new ArrayBuffer(4))
    server.deliver('not json')
    server.deliver('{"event":"screenshare.frame","data":{"png":"iVBORw0KGgo="}}')

    expect(deps.receive).toHaveBeenCalledTimes(1)
    expect(deps.receive).toHaveBeenCalledWith({ event: 'screenshare.frame', data: { png: 'iVBORw0KGgo=' } })
    server.closeFromPeer()
  })

  it('closes the socket on a message over the size limit', async () => {
    vi.stubGlobal('Response', class {
      constructor(_body: unknown, readonly init: { status: number }) {}
    })
    await serveMeetingFrames(upgrade(), 'meeting-1')

    server.deliver('x'.repeat(4 * 1024 * 1024 + 1))

    expect(server.closed).toEqual([[1009, 'Message too big']])
    expect(deps.receive).not.toHaveBeenCalled()
    server.closeFromPeer()
  })
})
