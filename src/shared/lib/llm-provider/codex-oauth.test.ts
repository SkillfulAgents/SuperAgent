import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODEX_OAUTH_CLIENT_ID, startCodexLogin, pollCodexLogin, refreshCodexCredential } from './codex-oauth'

const token = (accountId = 'account-a') => `header.${Buffer.from(JSON.stringify({ exp: 2000000000, email: 'test@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url')}.signature`
const previous = { accessToken: token(), refreshToken: 'old-refresh', accountId: 'account-a', expiresAt: 0 }
afterEach(() => vi.unstubAllGlobals())

describe('Codex device OAuth', () => {
  it('starts the official device flow with its public client and a bounded lifetime', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ device_auth_id: 'device-secret', user_code: 'ABCD', interval: '5' }))
    vi.stubGlobal('fetch', fetcher)
    const result = await startCodexLogin()
    expect(result.device).toMatchObject({ verification_uri: 'https://auth.openai.com/codex/device', user_code: 'ABCD', interval: 5, expires_in: 900 })
    expect(fetcher).toHaveBeenCalledWith('https://auth.openai.com/api/accounts/deviceauth/usercode', expect.objectContaining({ body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }) }))
  })

  it.each([403, 404])('keeps a %s poll pending without exchanging credentials', async status => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status }))
    vi.stubGlobal('fetch', fetcher)
    expect(await pollCodexLogin('id', 'code')).toEqual({ pending: 'authorization_pending' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('exchanges the one-time grant with its verifier and extracts account identity', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ authorization_code: 'grant', code_verifier: 'verifier' }))
      .mockResolvedValueOnce(Response.json({ access_token: token(), refresh_token: 'refresh' }))
    vi.stubGlobal('fetch', fetcher)
    const result = await pollCodexLogin('id', 'code')
    expect(result).toEqual({ credential: { accessToken: token(), refreshToken: 'refresh', accountId: 'account-a', accountLabel: 'test@example.com', expiresAt: 2000000000000 } })
    const fields = fetcher.mock.calls[1][1].body as URLSearchParams
    expect(fields.get('code_verifier')).toBe('verifier')
    expect(fields.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback')
  })

  it('rotates both tokens and retains the account on refresh', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ access_token: token(), refresh_token: 'new-refresh' })))
    expect(await refreshCodexCredential(previous)).toMatchObject({ refreshToken: 'new-refresh', accountId: 'account-a', expiresAt: 2000000000000 })
  })

  it('keeps the old refresh token when an exchange does not rotate it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ access_token: token() })))
    expect((await refreshCodexCredential(previous)).refreshToken).toBe('old-refresh')
  })

  it('reports reconnect guidance without disclosing upstream error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'private-provider-details' }, { status: 401 })))
    await expect(refreshCodexCredential(previous)).rejects.toThrow('Reconnect in Settings')
  })
})
