import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionChannel, type SessionEvent } from './session-channel'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SessionChannel', () => {
  it('delivers every event to every listener, in order, before emit returns', () => {
    const channel = new SessionChannel()
    const first: SessionEvent[] = []
    const second: SessionEvent[] = []
    channel.subscribe((event) => first.push(event))
    channel.subscribe((event) => second.push(event))

    channel.emit({ type: 'stream_start' })
    channel.emit({ type: 'stream_delta', text: 'hi' })

    expect(first).toEqual([{ type: 'stream_start' }, { type: 'stream_delta', text: 'hi' }])
    expect(second).toEqual(first)
  })

  it('emits to nobody when nobody listens', () => {
    const channel = new SessionChannel()
    expect(() => channel.emit({ type: 'session_idle' })).not.toThrow()
    expect(channel.listenerCount).toBe(0)
  })

  it('counts its listeners', () => {
    const channel = new SessionChannel()
    const off = channel.subscribe(() => {})
    channel.subscribe(() => {})
    expect(channel.listenerCount).toBe(2)
    off()
    expect(channel.listenerCount).toBe(1)
  })

  it('stops delivering to a listener once it unsubscribes, and leaves the others', () => {
    const channel = new SessionChannel()
    const gone: SessionEvent[] = []
    const kept: SessionEvent[] = []
    const off = channel.subscribe((event) => gone.push(event))
    channel.subscribe((event) => kept.push(event))

    channel.emit({ type: 'a' })
    off()
    channel.emit({ type: 'b' })

    expect(gone.map((e) => e.type)).toEqual(['a'])
    expect(kept.map((e) => e.type)).toEqual(['a', 'b'])
  })

  it('treats a second unsubscribe as a no-op', () => {
    const channel = new SessionChannel()
    const off = channel.subscribe(() => {})
    channel.subscribe(() => {})
    off()
    off()
    expect(channel.listenerCount).toBe(1)
  })

  it('keeps a throwing listener from reaching the emitter or the other listeners', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const channel = new SessionChannel()
    const before: SessionEvent[] = []
    const after: SessionEvent[] = []
    channel.subscribe((event) => before.push(event))
    channel.subscribe(() => {
      throw new Error('listener broke')
    })
    channel.subscribe((event) => after.push(event))

    expect(() => channel.emit({ type: 'stream_start' })).not.toThrow()
    expect(before).toEqual([{ type: 'stream_start' }])
    expect(after).toEqual([{ type: 'stream_start' }])
  })
})
