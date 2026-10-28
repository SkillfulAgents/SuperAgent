import { afterEach, describe, expect, it, vi } from 'vitest'
import { pollKimiLogin, refreshKimiCredential, startKimiLogin } from './kimi-oauth'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const fetchMock = vi.fn<typeof fetch>()
vi.stubGlobal('fetch', fetchMock)
afterEach(() => fetchMock.mockReset())
const urls = () => fetchMock.mock.calls.map(([input]) => String(input))

describe('Kimi device sign-in', () => {
  it.each([
    ['us', 'https://auth.kimi.ai', 'https://api.kimi.ai/coding/v1/me', 'https://www.kimi.ai/code/authorize_device'],
    ['cn', 'https://auth.kimi.com', 'https://api.kimi.com/coding/v1/me', 'https://www.kimi.com/code/authorize_device'],
  ] as const)('signs in and identifies the account in the %s region', async (region, auth, me, page) => {
    fetchMock
      .mockResolvedValueOnce(json({ device_code: 'device', user_code: 'CODE', verification_uri: page, verification_uri_complete: `${page}?user_code=CODE`, expires_in: 1800, interval: 5 }))
      .mockResolvedValueOnce(json({ access_token: 'access', refresh_token: 'refresh', expires_in: 900 }))
      .mockResolvedValueOnce(json({ user_id: 'user-1', email: 'alice@example.com', nickname: 'Alice' }))
    const { device } = await startKimiLogin(region)
    const result = await pollKimiLogin(device.device_code, region)
    expect(urls()).toEqual([`${auth}/api/oauth/device_authorization`, `${auth}/api/oauth/token`, me])
    expect(result).toEqual({ credential: expect.objectContaining({ region, accessToken: 'access', refreshToken: 'refresh', accountId: 'user-1', accountLabel: 'alice@example.com' }) })
  })

  it('reports pending authorization without issuing credentials', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'authorization_pending' }, 400))
    await expect(pollKimiLogin('device', 'us')).resolves.toEqual({ pending: 'authorization_pending' })
  })

  it('rejects a verification page outside Kimi', async () => {
    fetchMock.mockResolvedValueOnce(json({ device_code: 'd', user_code: 'C', verification_uri: 'https://kimi.example.com/device', expires_in: 1800, interval: 5 }))
    await expect(startKimiLogin('us')).rejects.toThrow()
  })
})

describe('Kimi credential refresh', () => {
  const previous = { accessToken: 'old', refreshToken: 'refresh-old', expiresAt: 0, accountId: 'user-1', region: 'cn' }

  it('refreshes in the issuing region and keeps account identity', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 'new', refresh_token: 'refresh-new', expires_in: 900 }))
    const next = await refreshKimiCredential(previous)
    expect(urls()).toEqual(['https://auth.kimi.com/api/oauth/token'])
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain('refresh_token=refresh-old')
    expect(next).toMatchObject({ accessToken: 'new', refreshToken: 'refresh-new', accountId: 'user-1', region: 'cn' })
  })

  it('refreshes credentials without a stored region in the US region', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 'new', expires_in: 900 }))
    await expect(refreshKimiCredential({ ...previous, region: undefined })).resolves.toMatchObject({ region: 'us', refreshToken: 'refresh-old' })
    expect(urls()).toEqual(['https://auth.kimi.ai/api/oauth/token'])
  })

  it('asks for reconnect when Kimi rejects the refresh token', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400))
    await expect(refreshKimiCredential(previous)).rejects.toMatchObject({ status: 401 })
  })
})
