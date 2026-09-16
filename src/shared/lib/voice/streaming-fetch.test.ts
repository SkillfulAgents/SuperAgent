import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWithIdleTimeout } from './streaming-fetch'

afterEach(() => vi.useRealTimers())
function source() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const cancel = vi.fn()
  const request = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c }, cancel })))
  return { request, cancel, chunk: () => controller.enqueue(new Uint8Array([1, 0])), end: () => controller.close() }
}
describe('streaming fetch deadlines', () => {
  it('allows healthy streams past the deadline and cleans up after EOF', async () => {
    vi.useFakeTimers()
    const upstream = source()
    const response = await fetchWithIdleTimeout(upstream.request, '/speech', {})
    const reader = response.body!.getReader()
    for (let i = 0; i < 4; i++) {
      const read = reader.read()
      await vi.advanceTimersByTimeAsync(20_000)
      upstream.chunk()
      expect((await read).value).toEqual(new Uint8Array([1, 0]))
    }
    upstream.end()
    expect((await reader.read()).done).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('aborts a request that never produces headers', async () => {
    vi.useFakeTimers()
    const request = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    }))
    const result = fetchWithIdleTimeout(request, '/speech', {})
    const rejected = expect(result).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })
  it('times out stalled chunks and cancels the source', async () => {
    vi.useFakeTimers()
    const upstream = source()
    const response = await fetchWithIdleTimeout(upstream.request, '/speech', {})
    const rejected = expect(response.body!.getReader().read()).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    expect(upstream.cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not mistake downstream backpressure for a stalled upstream', async () => {
    vi.useFakeTimers()
    const upstream = source()
    const response = await fetchWithIdleTimeout(upstream.request, '/speech', {})
    await vi.advanceTimersByTimeAsync(90_000)
    upstream.chunk()
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 0]))
    await reader.cancel()
    expect(upstream.cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('propagates caller cancellation while waiting for audio', async () => {
    vi.useFakeTimers()
    const upstream = source()
    const abort = new AbortController()
    const response = await fetchWithIdleTimeout(upstream.request, '/speech', { signal: abort.signal })
    const rejected = expect(response.body!.getReader().read()).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await rejected
    expect(upstream.cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
