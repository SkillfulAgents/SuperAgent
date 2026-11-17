import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { appState, closeAppState, digestKeyPart } from '@shared/lib/app-state'
import { authAttempts, authRateLimit } from './rate-limit'

const T0 = Date.parse('2026-11-04T12:00:00Z')
const WINDOW_MS = 15 * 60_000

function createApp() {
  const app = new Hono()
  app.use('/api/auth/*', authRateLimit)
  app.on(['GET', 'POST'], '/api/auth/*', (c) => c.json({ ok: true }))
  return app
}

function post(app: Hono, headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.7' }) {
  return app.request('http://localhost/api/auth/sign-in/email', { method: 'POST', headers })
}

async function admitted(app: Hono, count: number, headers?: Record<string, string>): Promise<number> {
  let ok = 0
  for (let i = 0; i < count; i++) if ((await post(app, headers)).status === 200) ok++
  return ok
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('authRateLimit', () => {
  it('admits 100 auth POSTs per client in 15 minutes, then answers 429 without counting', async () => {
    const app = createApp()
    expect(await admitted(app, 100)).toBe(100)

    const refused = await post(app)
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual({ error: 'Too many attempts. Please try again later.' })
    // No rate-limit headers, as before.
    expect(refused.headers.get('retry-after')).toBeNull()

    const counter = await appState().get(authAttempts.key(digestKeyPart('203.0.113.7')))
    expect(counter).toMatchObject({ value: 100, expiresAt: T0 + WINDOW_MS })
  })

  it('keeps the window that the first POST opened', async () => {
    const app = createApp()
    await post(app)
    vi.setSystemTime(T0 + WINDOW_MS - 1)
    expect(await admitted(app, 100)).toBe(99)

    vi.setSystemTime(T0 + WINDOW_MS)
    expect((await post(app)).status).toBe(200)
  })

  it('admits exactly 100 of competing POSTs', async () => {
    const app = createApp()
    const results = await Promise.all(Array.from({ length: 150 }, () => post(app)))
    expect(results.filter((res) => res.status === 200)).toHaveLength(100)
    expect(results.filter((res) => res.status === 429)).toHaveLength(50)
  })

  it('does not count other methods', async () => {
    const app = createApp()
    for (let i = 0; i < 101; i++) {
      await app.request('http://localhost/api/auth/get-session', { headers: { 'x-forwarded-for': '203.0.113.7' } })
    }
    expect((await post(app)).status).toBe(200)
  })

  it('counts against x-forwarded-for as sent, then x-real-ip, then one unknown client', async () => {
    const app = createApp()
    await admitted(app, 100, { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })
    expect((await post(app, { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })).status).toBe(429)
    // Another header value is another client.
    expect((await post(app, { 'x-forwarded-for': '203.0.113.7' })).status).toBe(200)
    expect((await post(app, { 'x-real-ip': '203.0.113.7, 10.0.0.1' })).status).toBe(429)

    await admitted(app, 100, {})
    expect((await post(app, {})).status).toBe(429)
    expect(await appState().get(authAttempts.key(digestKeyPart('unknown')))).toMatchObject({ value: 100 })
  })

  it('fails the request when the counter cannot be reached', async () => {
    const app = createApp()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await closeAppState()

    expect((await post(app)).status).toBe(500)
    consoleError.mockRestore()
  })
})
