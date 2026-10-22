/**
 * The session streams the actor hands out (`messages.subscribe`,
 * `messages.follow`), over a stand-in for the agent's `LiveSessions` that
 * calls its listeners when told to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessions } from './live/live-sessions'
import type { SessionEvent, WireFrame } from './live/session-channel'
import { sessionEvents, sessionFrames } from './session-streams'

function fakeLive({ catchUp = [] as WireFrame[] } = {}) {
  const listeners = new Set<(event: SessionEvent) => void>()
  const followers = new Set<(frame: WireFrame) => void>()
  const disposers = new Set<() => void>()
  const released = vi.fn()
  const live = {
    listen: (_sessionId: string, listener: (event: SessionEvent) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        released()
      }
    },
    follow: async (_sessionId: string, _after: string | undefined, onFrame: (frame: WireFrame) => void) => {
      followers.add(onFrame)
      for (const frame of catchUp) onFrame(frame)
      return () => {
        followers.delete(onFrame)
        released()
      }
    },
    isActive: () => true,
    turnOutcome: () => null,
    onDispose: (close: () => void) => {
      disposers.add(close)
      return () => disposers.delete(close)
    },
  }
  return {
    live: live as unknown as LiveSessions,
    released,
    dispose: () => [...disposers].forEach((close) => close()),
    watching: () => disposers.size,
    emit: (event: SessionEvent) => listeners.forEach((listener) => listener(event)),
    send: (frame: WireFrame) => followers.forEach((follower) => follower(frame)),
  }
}

const frame = (n: number): WireFrame => ({ id: `e:${n}`, data: `{"n":${n}}` })

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const read: T[] = []
  const reader = stream.getReader()
  for (let next = await reader.read(); !next.done; next = await reader.read()) read.push(next.value)
  return read
}

describe('sessionEvents', () => {
  it('carries each event as it happens', async () => {
    const fake = fakeLive()
    const reader = sessionEvents(fake.live, 's').getReader()
    fake.emit({ type: 'stream_start' })
    fake.emit({ type: 'stream_end' })

    expect((await reader.read()).value).toEqual({ type: 'stream_start' })
    expect((await reader.read()).value).toEqual({ type: 'stream_end' })
  })

  it('ends once the agent is let go of', async () => {
    const fake = fakeLive()
    const stream = sessionEvents(fake.live, 's')
    fake.dispose()

    expect(await readAll(stream)).toEqual([])
    expect(fake.released).toHaveBeenCalledOnce()
  })

  it('stops listening once cancelled', async () => {
    const fake = fakeLive()
    const stream = sessionEvents(fake.live, 's')
    await stream.cancel()

    expect(fake.released).toHaveBeenCalledOnce()
    expect(() => fake.emit({ type: 'stream_start' })).not.toThrow()
    expect(fake.watching()).toBe(0)
  })
})

describe('sessionFrames', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('carries the catch-up, then each frame as it happens', async () => {
    const fake = fakeLive({ catchUp: [frame(0)] })
    const reader = (await sessionFrames(fake.live, 's', undefined)).getReader()
    fake.send(frame(1))

    expect((await reader.read()).value).toEqual(frame(0))
    expect((await reader.read()).value).toEqual(frame(1))
  })

  it('pings with what the session is doing', async () => {
    const fake = fakeLive()
    const reader = (await sessionFrames(fake.live, 's', undefined, { pingMs: 1000 })).getReader()
    vi.advanceTimersByTime(1000)

    expect((await reader.read()).value).toEqual({ data: JSON.stringify({ type: 'ping', isActive: true, turnOutcome: null }) })
  })

  it('ends the stream through the same cleanup when a ping cannot be built', async () => {
    const fake = fakeLive()
    fake.live.isActive = () => {
      throw new Error('session state gone')
    }
    const reader = (await sessionFrames(fake.live, 's', undefined, { pingMs: 1000 })).getReader()
    vi.advanceTimersByTime(1000)

    await expect(reader.read()).rejects.toThrow('session state gone')
    expect(fake.released).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends, after the frames it holds, once the agent is let go of', async () => {
    const fake = fakeLive()
    const stream = await sessionFrames(fake.live, 's', undefined, { pingMs: 1000 })
    fake.send(frame(1))
    fake.dispose()

    expect(await readAll(stream)).toEqual([frame(1)])
    expect(fake.released).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets go and stops pinging once cancelled', async () => {
    const fake = fakeLive()
    const stream = await sessionFrames(fake.live, 's', undefined, { pingMs: 1000 })
    await stream.cancel()
    vi.advanceTimersByTime(5000)

    expect(fake.released).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(fake.watching()).toBe(0)
  })

  it('ends the stream of a reader too far behind, after the frames it holds', async () => {
    const fake = fakeLive()
    const stream = await sessionFrames(fake.live, 's', undefined, { maxPendingFrames: 2 })
    fake.send(frame(1))
    fake.send(frame(2))
    fake.send(frame(3))

    expect(fake.released).toHaveBeenCalledOnce()
    expect(await readAll(stream)).toEqual([frame(1), frame(2)])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets go of a reader cut off while being caught up, and never pings it', async () => {
    const fake = fakeLive({ catchUp: [frame(1), frame(2), frame(3)] })
    const stream = await sessionFrames(fake.live, 's', 'e:0', { maxPendingFrames: 2 })

    expect(fake.released).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(await readAll(stream)).toEqual([frame(1), frame(2)])
  })
})
