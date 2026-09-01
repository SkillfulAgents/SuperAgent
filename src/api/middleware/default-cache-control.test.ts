import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { defaultCacheControl } from './default-cache-control'

function createApp() {
  const app = new Hono()
  app.use('/api/*', defaultCacheControl)
  return app
}

describe('defaultCacheControl', () => {
  it('marks a route that makes no caching claim uncacheable', async () => {
    const app = createApp()
    app.get('/api/agents', c => c.json({ agents: [] }))

    const res = await app.request('/api/agents')

    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('leaves a route that opted into caching alone', async () => {
    const app = createApp()
    app.get('/api/llm/anthropic-sdk.js', c =>
      c.body('bundle', 200, { 'Cache-Control': 'public, max-age=86400' }))

    const res = await app.request('/api/llm/anthropic-sdk.js')

    expect(res.headers.get('cache-control')).toBe('public, max-age=86400')
  })

  it('leaves an SSE stream own no-cache in place', async () => {
    const app = createApp()
    app.get('/api/notifications/stream', c => streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: 'hello' })
    }))

    const res = await app.request('/api/notifications/stream')

    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  it('covers a response a handler built itself rather than through the context', async () => {
    const app = createApp()
    app.get('/api/agents/a/files/out.mp4', () => new Response('bytes', { status: 206 }))

    const res = await app.request('/api/agents/a/files/out.mp4')

    expect(res.status).toBe(206)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })
})
