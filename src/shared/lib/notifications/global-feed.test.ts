import { describe, expect, it, vi } from 'vitest'
import { GlobalFeed, type GlobalFeedEvent, type GlobalFeedListener } from './global-feed'

/** One bus every process reaches, as a deployment's feed hub would be. */
function sharedBus() {
  const listeners = new Set<GlobalFeedListener>()
  return {
    publish: (event: GlobalFeedEvent) => listeners.forEach((listener) => listener(event)),
    subscribe: (listener: GlobalFeedListener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    size: () => listeners.size,
  }
}

describe('GlobalFeed', () => {
  it('delivers each event to every listener before publish returns, in order', () => {
    const feed = new GlobalFeed()
    const seen: string[] = []
    feed.subscribe((event) => seen.push(`a:${event.type}`))
    feed.subscribe((event) => seen.push(`b:${event.type}`))

    feed.publish({ type: 'one' })
    feed.publish({ type: 'two' })

    expect(seen).toEqual(['a:one', 'b:one', 'a:two', 'b:two'])
  })

  it('stops delivering to a listener once it unsubscribes', () => {
    const feed = new GlobalFeed()
    const listener = vi.fn<(event: GlobalFeedEvent) => void>()
    const unsubscribe = feed.subscribe(listener)

    feed.publish({ type: 'before' })
    unsubscribe()
    feed.publish({ type: 'after' })

    expect(listener.mock.calls.map(([event]) => event.type)).toEqual(['before'])
  })

  it('keeps a throwing listener from reaching the publisher or the other listeners', () => {
    const feed = new GlobalFeed()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = vi.fn()
    feed.subscribe(() => {
      throw new Error('stream closed')
    })
    feed.subscribe(after)

    expect(() => feed.publish({ type: 'session_idle', agentSlug: 'a' })).not.toThrow()
    expect(after).toHaveBeenCalledWith({ type: 'session_idle', agentSlug: 'a' })
    expect(errors).toHaveBeenCalledWith('[GlobalFeed] Listener failed:', expect.any(Error))
    errors.mockRestore()
  })

  it('moves a listener that subscribed before the transport was set onto the transport', () => {
    const bus = sharedBus()
    const feed = new GlobalFeed()
    const seen: string[] = []
    const unsubscribe = feed.subscribe((event) => seen.push(event.type))

    feed.setTransport(bus)
    const otherProcess = new GlobalFeed()
    otherProcess.setTransport(bus)
    otherProcess.publish({ type: 'session_idle', agentSlug: 'a' })
    unsubscribe()
    otherProcess.publish({ type: 'session_active', agentSlug: 'a' })

    expect(seen).toEqual(['session_idle'])
    expect(bus.size()).toBe(0)
  })

  it('lets a listener unsubscribe itself mid-publish without skipping the others', () => {
    const feed = new GlobalFeed()
    const later = vi.fn()
    const unsubscribe = feed.subscribe(() => unsubscribe())
    feed.subscribe(later)

    feed.publish({ type: 'one' })
    feed.publish({ type: 'two' })

    expect(later).toHaveBeenCalledTimes(2)
  })
})
