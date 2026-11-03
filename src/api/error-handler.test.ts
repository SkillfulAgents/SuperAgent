import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import app from './index'
import { apiErrorHandler } from './error-handler'

/**
 * Hono's middleware refuses a request by throwing an HTTPException. The global
 * handler used to turn those into 500s (SUP-1317) while route tests mounted on
 * a bare Hono app still saw Hono's default, so assert against the real app.
 */
describe('API error handler', () => {
  const postJson = (body: string) => app.request('/api/agents/members/batch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  })

  it('answers a body over the route limit with 413', async () => {
    const res = await postJson('x'.repeat(33 * 1024))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'Payload Too Large' })
  })

  it('answers malformed JSON with 400', async () => {
    const res = await postJson('{nope')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Malformed JSON in request body' })
  })

  it('keeps any other error an opaque 500', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = new Hono().get('/', () => { throw new Error('database path /secret') }).onError(apiErrorHandler)
    const res = await failing.request('/')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error' })
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
