import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserFrameRelay, FRAME_DRAIN_POLL_MS, WEBSOCKET_OPEN, type FrameSink } from './browser-frame-relay'

class FakeSocket implements FrameSink {
  readyState = WEBSOCKET_OPEN
  bufferedAmount = 0
  sent: Array<{ data: string; binary: boolean }> = []
  send(data: Buffer | ArrayBuffer | Buffer[], options: { binary: boolean }) {
    this.sent.push({ data: Buffer.isBuffer(data) ? data.toString() : String(data), binary: options.binary })
  }
}

describe('BrowserFrameRelay', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('passes text and frames straight through while the socket keeps up', () => {
    const socket = new FakeSocket()
    const relay = new BrowserFrameRelay(socket, 100)
    relay.forward(Buffer.from('{"type":"state"}'), false)
    relay.forward(Buffer.from('frame-1'), true)
    expect(socket.sent).toEqual([{ data: '{"type":"state"}', binary: false }, { data: 'frame-1', binary: true }])
  })

  it('holds frames back on a congested socket and sends the newest once it drains', () => {
    const socket = new FakeSocket()
    const relay = new BrowserFrameRelay(socket, 100)
    socket.bufferedAmount = 500
    relay.forward(Buffer.from('frame-1'), true)
    relay.forward(Buffer.from('frame-2'), true)
    // Text still goes through: state updates are small and must not lag the picture.
    relay.forward(Buffer.from('{"type":"tabs"}'), false)
    expect(socket.sent).toEqual([{ data: '{"type":"tabs"}', binary: false }])
    vi.advanceTimersByTime(FRAME_DRAIN_POLL_MS)
    expect(socket.sent).toHaveLength(1)
    // The page stopped repainting; the viewer must still end on its last state.
    socket.bufferedAmount = 0
    vi.advanceTimersByTime(FRAME_DRAIN_POLL_MS)
    expect(socket.sent.at(-1)).toEqual({ data: 'frame-2', binary: true })
    expect(socket.sent.filter(entry => entry.binary)).toHaveLength(1)
  })

  it('discards a held frame when a newer one gets through or the viewer leaves', () => {
    const socket = new FakeSocket()
    const relay = new BrowserFrameRelay(socket, 100)
    socket.bufferedAmount = 500
    relay.forward(Buffer.from('old'), true)
    socket.bufferedAmount = 0
    relay.forward(Buffer.from('new'), true)
    vi.advanceTimersByTime(FRAME_DRAIN_POLL_MS * 2)
    expect(socket.sent.map(entry => entry.data)).toEqual(['new'])
    socket.bufferedAmount = 500
    relay.forward(Buffer.from('late'), true)
    relay.close()
    socket.bufferedAmount = 0
    vi.advanceTimersByTime(FRAME_DRAIN_POLL_MS * 2)
    expect(socket.sent.map(entry => entry.data)).toEqual(['new'])
    socket.readyState = 3
    relay.forward(Buffer.from('closed'), true)
    expect(socket.sent.map(entry => entry.data)).toEqual(['new'])
  })
})
