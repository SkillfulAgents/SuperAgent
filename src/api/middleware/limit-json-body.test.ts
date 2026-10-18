import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { limitJsonBody, type LimitedJsonBodyEnv } from './limit-json-body'

function createApp(maxBytes: number) {
  const app = new Hono<LimitedJsonBodyEnv>()
  const received = vi.fn<(request: Request, body: unknown) => void>()
  const failed = vi.fn()
  app.post('/', limitJsonBody(maxBytes), (c) => {
    received(c.req.raw, c.get('limitedJsonBody'))
    return c.json({ body: c.get('limitedJsonBody') })
  })
  app.onError((error, c) => {
    failed(error)
    return c.json({ error: 'Internal server error' }, 500)
  })
  return { app, received, failed }
}

function streamedRequest(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, signal, duplex: 'half' }
  return new Request('http://localhost/', init)
}

describe('limitJsonBody', () => {
  it.each([undefined, '', '{"incomplete":'])('passes absent or invalid JSON (%s) to the route as null', async (body) => {
    const { app } = createApp(32)
    const response = await app.request('/', { method: 'POST', body })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ body: null })
  })

  it('accepts split UTF-8 at the byte limit and preserves the request and its abort signal', async () => {
    const json = { message: 'Hello é😀' }
    const bytes = Buffer.from(JSON.stringify(json))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array())
        for (let offset = 0; offset < bytes.length; offset++) controller.enqueue(bytes.subarray(offset, offset + 1))
        controller.close()
      },
    })
    const controller = new AbortController()
    const request = streamedRequest(body, controller.signal)
    const { app, received } = createApp(bytes.length)

    const response = await app.request(request)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ body: json })
    expect(received).toHaveBeenCalledExactlyOnceWith(request, json)
    expect(received.mock.calls[0][0]).toBe(request)
    expect(body.locked).toBe(false)
    controller.abort()
    expect(received.mock.calls[0][0].signal.aborted).toBe(true)
  })

  it.each(['hangs', 'rejects'])('returns 413 before the sender finishes even when cancellation %s', async (kind) => {
    const cancel = vi.fn(() => kind === 'hangs'
      ? new Promise<void>(() => {})
      : Promise.reject(new Error('sender disconnected')))
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new Uint8Array(3))
    })
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
    const { app, received, failed } = createApp(4)

    const response = await app.request(streamedRequest(body))

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Payload Too Large' })
    expect(received).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
    expect(pull).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })

  it('propagates stream failures to the error boundary and releases the reader', async () => {
    const error = new Error('sender disconnected')
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(error) },
    }, { highWaterMark: 0 })
    const { app, received, failed } = createApp(32)

    const response = await app.request(streamedRequest(body))

    expect(response.status).toBe(500)
    expect(failed).toHaveBeenCalledExactlyOnceWith(error)
    expect(received).not.toHaveBeenCalled()
    expect(body.locked).toBe(false)
  })
})
