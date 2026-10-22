import { describe, expect, it, vi } from 'vitest'
import { GlobalFeed, type GlobalFeedEvent } from './global-feed'

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
