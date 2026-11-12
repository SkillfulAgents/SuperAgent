import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { batchReads, MAX_BATCHED_READS } from './batch-reads'

/** An app with two of the reads, one of them refused, and the batch route in front of them. */
function app() {
  const seen: Array<{ path: string; cookie: string | null; contentType: string | null }> = []
  const inner = new Hono()
  // The reads the app was handed, not the batch that carried them.
  inner.use('*', async (c, next) => {
    const { pathname, search } = new URL(c.req.url)
    if (pathname !== '/api/batch-reads') seen.push({ path: pathname + search, cookie: c.req.header('cookie') ?? null, contentType: c.req.header('content-type') ?? null })
    await next()
  })
  inner.get('/api/agents/:id/hooks', (c) => c.json({ hooks: [{ id: 'hook-1' }] }))
  inner.get('/api/agents/:id/mounts', (c) => c.json({ error: 'Forbidden' }, 403))
  inner.get('/api/activity/agents/:id', (c) => c.json({ days: c.req.query('days') }))
  inner.get('/api/settings', (c) => c.json({ secret: true }))
  inner.route('/api/batch-reads', batchReads((request) => inner.fetch(request)))
  const batch = (paths: unknown) => inner.request('/api/batch-reads', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'session=abc' },
    body: JSON.stringify({ paths }),
  })
  return { batch, seen }
}

describe('batchReads', () => {
  it("answers each read with the status and body its own route gives, in the order asked", async () => {
    const { batch } = app()

    const response = await batch(['/api/agents/sales/hooks', '/api/agents/sales/mounts', '/api/activity/agents/sales?days=14'])

    expect(response.status).toBe(200)
    const { results } = (await response.json()) as { results: Array<{ status: number; contentType: string; body: string }> }
    expect(results.map((result) => [result.status, JSON.parse(result.body)])).toEqual([
      [200, { hooks: [{ id: 'hook-1' }] }],
      [403, { error: 'Forbidden' }],
      [200, { days: '14' }],
    ])
    expect(results[0].contentType).toContain('application/json')
  })

  it("sends each read as the caller, without the batch's body headers", async () => {
    const { batch, seen } = app()

    await batch(['/api/agents/sales/hooks'])

    expect(seen).toEqual([{ path: '/api/agents/sales/hooks', cookie: 'session=abc', contentType: null }])
  })

  it('refuses a path that is not one of the reads, and sends none of the batch', async () => {
    const { batch, seen } = app()

    const response = await batch(['/api/agents/sales/hooks', '/api/settings'])

    expect(response.status).toBe(400)
    expect(seen).toEqual([])
  })

  it('refuses a path that would name another route once normalized', async () => {
    const { batch, seen } = app()

    const response = await batch(['/api/agents/../hooks'])

    expect(response.status).toBe(400)
    expect(seen).toEqual([])
  })

  it('refuses an empty batch, one over the limit, and a body that is not a list of paths', async () => {
    const { batch } = app()

    expect((await batch([])).status).toBe(400)
    expect((await batch(Array.from({ length: MAX_BATCHED_READS + 1 }, () => '/api/volume-definitions'))).status).toBe(400)
    expect((await batch('/api/volume-definitions')).status).toBe(400)
  })
})
