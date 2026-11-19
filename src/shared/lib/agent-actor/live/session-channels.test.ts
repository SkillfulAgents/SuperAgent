import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent, WireFrame } from './session-channel'
import { RECONNECT_GRACE_MS, SessionChannels, wireFrame } from './session-channels'

afterEach(() => {
  vi.useRealTimers()
})

/** A viewer's wire: every frame it was handed, in order. */
function viewer() {
  const frames: WireFrame[] = []
  return {
    frames,
    onFrame: (frame: WireFrame) => frames.push(frame),
    events: () => frames.map((frame) => JSON.parse(frame.data) as SessionEvent),
    types: () => frames.map((frame) => (JSON.parse(frame.data) as SessionEvent).type),
    lastId: () => [...frames].reverse().find((frame) => frame.id)?.id,
  }
}

const snapshot = (lastId: string) => [wireFrame({ type: 'connected' }, lastId)]
const fresh = { snapshot }
const after = (id: string | undefined) => ({ after: id, snapshot })

describe('SessionChannels', () => {
  it('drops an event for a session nobody listens to', () => {
    const channels = new SessionChannels()
    channels.emit('s', { type: 'stream_start' })
    const v = viewer()
    channels.follow('s', fresh, v.onFrame)
    expect(v.types()).toEqual(['connected'])
  })

  it('hands a new viewer a snapshot standing for every event so far, then every event after', () => {
    const channels = new SessionChannels()
    const early = viewer()
    channels.follow('s', fresh, early.onFrame)
    channels.emit('s', { type: 'stream_start' })

    const late = viewer()
    channels.follow('s', fresh, late.onFrame)
    channels.emit('s', { type: 'stream_delta', text: 'hi' })

    expect(early.types()).toEqual(['connected', 'stream_start', 'stream_delta'])
    expect(late.types()).toEqual(['connected', 'stream_delta'])
    // The late snapshot stands for stream_start: resuming after it skips it.
    expect(late.frames[0].id).toBe(early.frames[1].id)
  })

  it('gives two viewers the same frames, ids included', () => {
    const channels = new SessionChannels()
    const a = viewer()
    const b = viewer()
    channels.follow('s', fresh, a.onFrame)
    channels.follow('s', fresh, b.onFrame)
    channels.emit('s', { type: 'x' })
    channels.emit('s', { type: 'y' })

    expect(a.frames.slice(1)).toEqual(b.frames.slice(1))
  })

  it('gives the app\'s own listeners the bare events, with no frames', () => {
    const channels = new SessionChannels()
    const heard: SessionEvent[] = []
    channels.listen('s', (event) => heard.push(event))
    channels.emit('s', { type: 'x', n: 1 })
    expect(heard).toEqual([{ type: 'x', n: 1 }])
  })

  it('replays exactly what a reconnecting viewer missed, with no snapshot', () => {
    const channels = new SessionChannels()
    const first = viewer()
    const stop = channels.follow('s', fresh, first.onFrame)
    channels.emit('s', { type: 'stream_delta', text: 'a' })
    const resumeAfter = first.lastId()
    stop()
    channels.emit('s', { type: 'stream_delta', text: 'b' })
    channels.emit('s', { type: 'stream_delta', text: 'c' })

    const again = viewer()
    const build = vi.fn(snapshot)
    channels.follow('s', { after: resumeAfter, snapshot: build }, again.onFrame)
    channels.emit('s', { type: 'session_idle' })

    expect(build).not.toHaveBeenCalled()
    expect(again.events().map((event) => event.text ?? event.type)).toEqual(['b', 'c', 'session_idle'])
  })

  it('snapshots a viewer whose id it cannot resume from', () => {
    const channels = new SessionChannels()
    channels.follow('s', fresh, viewer().onFrame)
    channels.emit('s', { type: 'x' })

    const v = viewer()
    channels.follow('s', after('some-other-process:41'), v.onFrame)

    expect(v.types()).toEqual(['connected'])
  })

  describe('after the last viewer leaves', () => {
    it('keeps the channel and its frames through the grace period', () => {
      vi.useFakeTimers()
      const channels = new SessionChannels()
      const first = viewer()
      const stop = channels.follow('s', fresh, first.onFrame)
      channels.emit('s', { type: 'a' })
      stop()

      vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1)
      channels.emit('s', { type: 'b' })
      const again = viewer()
      channels.follow('s', after(first.lastId()), again.onFrame)

      expect(again.types()).toEqual(['b'])
    })

    it('drops a channel nobody came back to, so a late viewer starts over from a snapshot', () => {
      vi.useFakeTimers()
      const channels = new SessionChannels({ graceMs: 1000 })
      const first = viewer()
      channels.follow('s', fresh, first.onFrame)()
      channels.emit('s', { type: 'a' })

      vi.advanceTimersByTime(1000)
      channels.emit('s', { type: 'lost' })
      const late = viewer()
      channels.follow('s', after(first.lastId()), late.onFrame)

      expect(late.types()).toEqual(['connected'])
    })

    it('stops keeping frames for a channel the app still listens to', () => {
      vi.useFakeTimers()
      const channels = new SessionChannels({ graceMs: 1000 })
      const heard: string[] = []
      channels.listen('s', (event) => heard.push(event.type))
      const first = viewer()
      channels.follow('s', fresh, first.onFrame)()

      vi.advanceTimersByTime(1000)
      channels.emit('s', { type: 'after-grace' })
      const late = viewer()
      channels.follow('s', after(first.lastId()), late.onFrame)

      // The app's listener still hears; the late viewer cannot be replayed to.
      expect(heard).toEqual(['after-grace'])
      expect(late.types()).toEqual(['connected'])
    })

    it('a viewer back within the grace period keeps the channel past it', () => {
      vi.useFakeTimers()
      const channels = new SessionChannels({ graceMs: 1000 })
      const first = viewer()
      channels.follow('s', fresh, first.onFrame)()
      vi.advanceTimersByTime(500)
      const again = viewer()
      channels.follow('s', after(first.lastId()), again.onFrame)

      vi.advanceTimersByTime(5000)
      channels.emit('s', { type: 'still-here' })
      const third = viewer()
      channels.follow('s', after(again.lastId()), third.onFrame)

      expect(again.types()).toEqual(['still-here'])
      expect(third.types()).toEqual([])
    })
  })

  it('treats a second unsubscribe as a no-op', () => {
    vi.useFakeTimers()
    const channels = new SessionChannels({ graceMs: 1000 })
    const stay = viewer()
    const stop = channels.follow('s', fresh, viewer().onFrame)
    channels.follow('s', fresh, stay.onFrame)
    stop()
    stop()
    vi.advanceTimersByTime(5000)
    channels.emit('s', { type: 'x' })

    expect(stay.types()).toEqual(['connected', 'x'])
  })

  it('leaves no viewer attached, and lets the channel wind down, when catching up throws', () => {
    vi.useFakeTimers()
    const channels = new SessionChannels({ graceMs: 1000 })
    const onFrame = vi.fn(() => {
      throw new Error('write failed')
    })

    expect(() => channels.follow('s', fresh, onFrame)).toThrow('write failed')
    channels.emit('s', { type: 'x' })
    expect(onFrame).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps sessions apart', () => {
    const channels = new SessionChannels()
    const a = viewer()
    channels.follow('a', fresh, a.onFrame)
    const heard: string[] = []
    channels.listen('b', (event) => heard.push(event.type))

    channels.emit('a', { type: 'for-a' })
    channels.emit('b', { type: 'for-b' })

    expect(a.types()).toEqual(['connected', 'for-a'])
    expect(heard).toEqual(['for-b'])
  })

  it('hears nothing more once disposed, and leaves no timer behind', () => {
    vi.useFakeTimers()
    const channels = new SessionChannels()
    const v = viewer()
    channels.follow('s', fresh, v.onFrame)
    channels.follow('t', fresh, viewer().onFrame)()

    channels.dispose()
    channels.emit('s', { type: 'after' })

    expect(v.types()).toEqual(['connected'])
    expect(vi.getTimerCount()).toBe(0)
  })
})
