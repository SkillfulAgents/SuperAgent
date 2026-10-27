import { describe, expect, it, vi } from 'vitest'
import { SSEStreamingApi } from 'hono/streaming'
import { waitForClientGone } from './wait-for-client-gone'

/** A real hono SSE stream whose response body nobody reads, like one @hono/node-server never piped. */
function unreadStream(): SSEStreamingApi {
  const { readable, writable } = new TransformStream()
  return new SSEStreamingApi(writable, readable)
}

async function settles(promise: Promise<unknown>, ms = 50): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), ms)),
  ])
}

describe('waitForClientGone', () => {
  it('waits while the client is connected', async () => {
    const stream = unreadStream()
    expect(await settles(waitForClientGone(new AbortController().signal, stream))).toBe(false)
  })

  it('resolves when the stream aborts (a hangup heard through the response body)', async () => {
    const stream = unreadStream()
    const gone = waitForClientGone(new AbortController().signal, stream)
    stream.abort()
    expect(await settles(gone)).toBe(true)
  })

  it('resolves when the request signal aborts, and aborts the stream', async () => {
    const controller = new AbortController()
    const stream = unreadStream()
    const gone = waitForClientGone(controller.signal, stream)
    controller.abort()
    expect(await settles(gone)).toBe(true)
    expect(stream.aborted).toBe(true)
  })

  it('resolves at once for a stream that already aborted', async () => {
    const stream = unreadStream()
    stream.abort()
    expect(await settles(waitForClientGone(new AbortController().signal, stream))).toBe(true)
  })

  it('resolves at once for a request signal that already aborted, and aborts the stream', async () => {
    const controller = new AbortController()
    controller.abort()
    const stream = unreadStream()
    expect(await settles(waitForClientGone(controller.signal, stream))).toBe(true)
    expect(stream.aborted).toBe(true)
  })

  it('releases a write stuck waiting for a reader when the request signal aborts', async () => {
    const controller = new AbortController()
    const stream = unreadStream()
    const gone = waitForClientGone(controller.signal, stream)
    // The first chunk fits the stream's queue; the next waits for a reader.
    expect(await settles(stream.writeSSE({ data: 'connected', event: 'message' }))).toBe(true)
    const write = stream.writeSSE({ data: 'ping', event: 'message' })
    expect(await settles(write)).toBe(false)

    controller.abort()

    expect(await settles(write)).toBe(true)
    expect(await settles(gone)).toBe(true)
  })

  it('stops listening on the signal once the stream aborted, and tolerates both firing', async () => {
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const stream = unreadStream()
    const listener = vi.fn()
    stream.onAbort(listener)
    const gone = waitForClientGone(controller.signal, stream)

    stream.abort()
    controller.abort()

    expect(await settles(gone)).toBe(true)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(listener).toHaveBeenCalledOnce()
  })
})
