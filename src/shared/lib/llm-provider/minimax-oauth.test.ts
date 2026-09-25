import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pollMinimaxLogin, refreshMinimaxCredential, startMinimaxLogin } from './minimax-oauth'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const fetchMock = vi.fn<typeof fetch>()
vi.stubGlobal('fetch', fetchMock)
afterEach(() => fetchMock.mockReset())
const urls = () => fetchMock.mock.calls.map(([input]) => String(input))
const bodyOf = (call: number) => new URLSearchParams(String(fetchMock.mock.calls[call][1]?.body))

describe('MiniMax device sign-in', () => {
  it.each([
    ['global', 'https://account.minimax.io', 'https://platform.minimax.io/oauth/device'],
    ['cn', 'https://account.minimaxi.com', 'https://platform.minimaxi.com/oauth/device'],
  ] as const)('signs in with PKCE in the %s region', async (region, auth, page) => {
    const expiresAt = Date.now() + 1_800_000
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/device/code')) {
        const state = new URLSearchParams(String(init?.body)).get('state')
        return json({ user_code: 'CODE', verification_uri: page, expired_in: expiresAt, interval: 3000, state })
      }
      return json({ status: 'success', access_token: 'access', refresh_token: 'refresh', expired_in: expiresAt })
    })
    const login = await startMinimaxLogin(region)
    const result = await pollMinimaxLogin(login, region)
    expect(urls()).toEqual([`${auth}/oauth2/device/code`, `${auth}/oauth2/token`])
    const start = bodyOf(0)
    expect(start.get('code_challenge_method')).toBe('S256')
    expect(start.get('scope')).toBe('openid profile coding_plan')
    expect(createHash('sha256').update(bodyOf(1).get('code_verifier')!).digest('base64url')).toBe(start.get('code_challenge'))
    expect(bodyOf(1).get('user_code')).toBe('CODE')
    expect(result).toEqual({ credential: expect.objectContaining({ region, accessToken: 'access', refreshToken: 'refresh', expiresAt }) })
    expect(login.device.interval).toBe(3)
  })

  it('reports pending authorization without issuing credentials', async () => {
    fetchMock.mockResolvedValueOnce(json({ status: 'pending' }))
    await expect(pollMinimaxLogin({ device: { device_code: 's', user_code: 'CODE', verification_uri: 'https://platform.minimax.io/d', expires_in: 60, interval: 3 }, userCode: 'CODE', verifier: 'verifier' }, 'global'))
      .resolves.toEqual({ pending: 'authorization_pending' })
  })

  it('rejects a verification page outside MiniMax', async () => {
    fetchMock.mockImplementation(async (_input, init) => json({
      user_code: 'C', verification_uri: 'https://minimax.example/device', expired_in: Date.now() + 60_000, interval: 3000,
      state: new URLSearchParams(String(init?.body)).get('state'),
    }))
    await expect(startMinimaxLogin('global')).rejects.toThrow()
  })

  it('rejects a device response whose state does not match', async () => {
    fetchMock.mockResolvedValueOnce(json({ user_code: 'C', verification_uri: 'https://platform.minimax.io/device', expired_in: Date.now() + 60_000, interval: 3000, state: 'other' }))
    await expect(startMinimaxLogin('global')).rejects.toThrow(/could not be verified/)
  })
})

describe('MiniMax credential refresh', () => {
  const previous = { accessToken: 'old', refreshToken: 'refresh-old', expiresAt: 0, region: 'cn' }
  const expiresAt = Date.now() + 900_000

  it('refreshes in the issuing region and keeps the previous refresh token when omitted', async () => {
    fetchMock.mockResolvedValueOnce(json({ status: 'success', access_token: 'new', expired_in: expiresAt }))
    const next = await refreshMinimaxCredential(previous)
    expect(urls()).toEqual(['https://account.minimaxi.com/oauth2/token'])
    expect(bodyOf(0).get('refresh_token')).toBe('refresh-old')
    expect(next).toMatchObject({ accessToken: 'new', refreshToken: 'refresh-old', region: 'cn', expiresAt })
  })

  it('refreshes credentials without a stored region in the global region', async () => {
    fetchMock.mockResolvedValueOnce(json({ status: 'success', access_token: 'new', refresh_token: 'refresh-new', expired_in: expiresAt }))
    await expect(refreshMinimaxCredential({ ...previous, region: undefined })).resolves.toMatchObject({ region: 'global', refreshToken: 'refresh-new' })
    expect(urls()).toEqual(['https://account.minimax.io/oauth2/token'])
  })

  it('asks for reconnect when MiniMax rejects the refresh token', async () => {
    fetchMock.mockResolvedValueOnce(json({ status: 'error' }, 400))
    await expect(refreshMinimaxCredential(previous)).rejects.toMatchObject({ status: 401 })
  })
})
