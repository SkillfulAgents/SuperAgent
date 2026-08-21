import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import tokenExchange from './token-exchange'

/**
 * Same mount order as src/api/index.ts: custom exchange, then /api/auth/* wildcard.
 * Proves trailing-slash and suffix paths never receive the desktop session cookie.
 */
function mountAuthStack(): Hono {
  const app = new Hono()
  app.route('/api/auth/token', tokenExchange)
  app.on(['POST', 'GET'], '/api/auth/*', (c) => c.text('wild'))
  return app
}

describe('token exchange mount order', () => {
  it('sends trailing-slash and suffix POSTs to the Better Auth wildcard', async () => {
    const app = mountAuthStack()
    const slash = await app.request('/api/auth/token/exchange/', { method: 'POST' })
    expect(await slash.text()).toBe('wild')
    const leak = await app.request('/api/auth/token/exchange/leak', { method: 'POST' })
    expect(await leak.text()).toBe('wild')
    expect(slash.headers.get('set-cookie')).toBeNull()
    expect(leak.headers.get('set-cookie')).toBeNull()
  })

  it('does not issue a cookie on GET of the exchange path', async () => {
    const app = mountAuthStack()
    const res = await app.request('/api/auth/token/exchange', { method: 'GET' })
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})
