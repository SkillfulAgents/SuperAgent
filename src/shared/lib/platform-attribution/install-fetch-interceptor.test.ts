import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'https://proxy.test',
}))

const mockGetPlatformAccessToken = vi.fn()
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
}))

vi.mock('@shared/lib/db', () => {
  const chainable = {
    select: () => chainable,
    from: () => chainable,
    where: () => chainable,
    orderBy: () => chainable,
    limit: () => chainable,
    all: () => [{ accountId: 'sub_alice' }],
  }
  return { db: chainable }
})

vi.mock('@shared/lib/db/schema', () => ({
  authAccount: { userId: 'u', providerId: 'p', accountId: 'a', updatedAt: 't' },
}))

vi.mock('drizzle-orm', () => ({ eq: () => '=', and: () => '&', desc: () => 'DESC' }))

import { runWithRequestUser } from './index'
import {
  _uninstallPlatformFetchInterceptorForTest,
  installPlatformFetchInterceptor,
} from './install-fetch-interceptor'

const ORG_TOKEN = (() => {
  const header = Buffer.from('{"alg":"none"}').toString('base64url')
  const payload = Buffer.from(JSON.stringify({ orgId: 'org_42' })).toString('base64url')
  return `${header}.${payload}.sig`
})()

const realFetchMock = vi.fn()

beforeEach(() => {
  realFetchMock.mockReset()
  realFetchMock.mockResolvedValue(new Response(null, { status: 200 }))
  // Stub global fetch BEFORE installing the interceptor so the interceptor
  // wraps the stub. Tests that bypass the interceptor (set fetch directly)
  // would see their stub instead.
  globalThis.fetch = realFetchMock as unknown as typeof fetch
  installPlatformFetchInterceptor()
  mockGetPlatformAccessToken.mockReturnValue(ORG_TOKEN)
})

afterEach(() => {
  _uninstallPlatformFetchInterceptorForTest()
})

describe('installPlatformFetchInterceptor', () => {
  it('rewrites Authorization with the member-encoded bearer on platform-proxy URLs', async () => {
    await runWithRequestUser('user_alice', async () => {
      await fetch('https://proxy.test/v1/foo', { method: 'POST' })
    })
    expect(realFetchMock).toHaveBeenCalledTimes(1)
    const [, init] = realFetchMock.mock.calls[0]
    const headers = new Headers((init as RequestInit).headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${ORG_TOKEN}::sub_alice`)
  })

  it('passes through non-proxy URLs unchanged', async () => {
    await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    const [url, init] = realFetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    const headers = new Headers((init as RequestInit).headers)
    expect(headers.get('Authorization')).toBeNull()
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('is a no-op when no attribution scope is active', async () => {
    await fetch('https://proxy.test/v1/foo')
    const [, init] = realFetchMock.mock.calls[0]
    const headers = new Headers((init as RequestInit).headers)
    expect(headers.get('Authorization')).toBeNull()
  })

  it('preserves caller-supplied headers and init fields', async () => {
    await runWithRequestUser('user_alice', async () => {
      await fetch('https://proxy.test/v1/foo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-custom': '1' },
        body: '{"k":1}',
      })
    })
    const [, init] = realFetchMock.mock.calls[0]
    const headers = new Headers((init as RequestInit).headers)
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).body).toBe('{"k":1}')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-custom')).toBe('1')
    expect(headers.get('Authorization')).toBe(`Bearer ${ORG_TOKEN}::sub_alice`)
  })

  it('is idempotent — second install call does nothing', async () => {
    installPlatformFetchInterceptor()
    installPlatformFetchInterceptor()
    await runWithRequestUser('user_alice', async () => {
      await fetch('https://proxy.test/v1/foo')
    })
    // Wrapping twice would have called realFetchMock twice; assert single call.
    expect(realFetchMock).toHaveBeenCalledTimes(1)
  })
})
