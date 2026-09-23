import { afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ sources: [] as Array<{ url: string; options: { fetch: typeof fetch }; close: ReturnType<typeof vi.fn>; handlers: Map<string, (event: { lastEventId: string }) => void> }>, token: 'first' }))
vi.mock('eventsource', () => ({ EventSource: class {
  close = vi.fn()
  handlers = new Map()
  constructor(readonly url: string, readonly options: { fetch: typeof fetch }) { state.sources.push(this) }
  addEventListener(type: string, callback: unknown) { this.handlers.set(type, callback) }
} }))
vi.mock('./gateway-client', () => ({ emailBearer: async () => state.token }))
import { watchEmail } from './live'
afterEach(() => { state.sources.length = 0; vi.unstubAllGlobals() })
it('shares one SSE stream per member, preserves its cursor, and closes after the last subscriber', () => {
  const a = vi.fn(), b = vi.fn()
  const stopA = watchEmail(null, 'member', 'integration-a', 'mailbox-a', a)
  const stopB = watchEmail(null, 'member', 'integration-b', 'mailbox-b', b)
  expect(state.sources[0].close).toHaveBeenCalledOnce()
  expect(state.sources[1].url).toContain('mailbox-a,mailbox-b')
  state.sources[1].handlers.get('message.received')!({ lastEventId: '42' })
  expect(a).toHaveBeenCalledOnce(); expect(b).toHaveBeenCalledOnce()
  stopA()
  expect(state.sources[2].url).toContain('after=42')
  expect(state.sources[2].url).not.toContain('mailbox-a')
  stopB()
  expect(state.sources[2].close).toHaveBeenCalledOnce()
})
it('refreshes bearer auth for every SSE reconnect and rejects redirects', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(''))
  vi.stubGlobal('fetch', fetcher)
  const stop = watchEmail(null, 'member-2', 'integration', 'mailbox', vi.fn())
  try {
    for (const token of ['first', 'rotated']) {
      state.token = token
      await state.sources[0].options.fetch('https://email-gateway.datawizz.workers.dev/v1/events/stream', {})
      expect(fetcher).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ headers: { Authorization: `Bearer ${token}` }, redirect: 'error' }))
    }
  } finally { stop() }
})
