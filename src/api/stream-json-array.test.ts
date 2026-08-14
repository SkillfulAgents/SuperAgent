import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const mockCaptureException = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

import { streamJsonArrayResponse } from './stream-json-array'

const TAGS = { component: 'test', operation: 'stream-test' }

function appFor(items: unknown[]) {
  const app = new Hono()
  app.get('/items', (c) => streamJsonArrayResponse(c, items, { logLabel: 'test items', tags: TAGS }))
  return app
}

const get = (items: unknown[]) => appFor(items).request('http://localhost/items')

async function settle() {
  // Let the Node-side pipeline callback run.
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('streamJsonArrayResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('streams a body that parses to the same value c.json produced', async () => {
    const items = [
      { id: 'a', nested: { deep: [1, 2, 3] }, text: 'héllo "quoted" \n newline' },
      { id: 'b', value: null },
    ]
    const res = await get(items)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(items)))
  })

  it('serializes an empty array as []', async () => {
    const res = await get([])
    expect(await res.text()).toBe('[]')
  })

  it('serializes undefined elements as null, matching JSON.stringify of the array', async () => {
    const res = await get([undefined, { id: 1 }, undefined])
    expect(await res.text()).toBe('[null,{"id":1},null]')
  })

  it('streams a large array parse-identically', async () => {
    const items = Array.from({ length: 5000 }, (_, i) => ({
      id: `msg-${i}`,
      content: { text: 'x'.repeat(500) },
      toolCalls: [],
    }))
    const res = await get(items)
    const body = await res.json()
    expect(body).toEqual(items)
  })

  it('does not report when the client cancels the stream mid-body', async () => {
    const items = Array.from({ length: 10000 }, (_, i) => ({ id: i, pad: 'y'.repeat(1000) }))
    const res = await get(items)
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    await settle()
    expect(mockCaptureException).not.toHaveBeenCalled()
  })

  it('reports non-abort serialization failures with the given tags', async () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const res = await get([{ ok: true }, circular])
    // The body errors mid-stream; consume defensively.
    await res.text().catch(() => {})
    await settle()
    expect(mockCaptureException).toHaveBeenCalledTimes(1)
    expect(mockCaptureException).toHaveBeenCalledWith(expect.anything(), { tags: TAGS })
  })
})
