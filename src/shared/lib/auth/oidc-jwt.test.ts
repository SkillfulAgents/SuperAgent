import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { appState, closeAppState } from '@shared/lib/app-state'
import { _setOidcJwksResolverForTest, oidcJwksKey, verifyOidcJwt } from './oidc-jwt'

const ISSUER = 'https://auth.example.com'
const TEN_MINUTES = 10 * 60_000

async function signingKey(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }
  const sign = () =>
    new SignJWT({ org: 'org_sales' }).setProtectedHeader({ alg: 'RS256', kid }).setIssuer(ISSUER).setIssuedAt().setExpirationTime('5m').sign(privateKey)
  return { jwk, sign }
}

/** The issuer's /jwks, serving whatever keys it holds now; counts its downloads. */
function issuerServing(published: { keys: object[] }) {
  const download = vi.fn(async () => Response.json(published))
  vi.stubGlobal('fetch', download)
  return download
}

/** A new process: nothing in memory, the AppState kept. */
const newProcess = () => _setOidcJwksResolverForTest(null)

const stored = () => appState().get(oidcJwksKey(ISSUER))

// The test setup installs a fresh AppState per test: what a new process reads is what this one stored.
beforeEach(() => {
  newProcess()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('verifyOidcJwt with the AppState key-set cache', () => {
  it('verifies in a new process with the stored keys, without downloading them again', async () => {
    const current = await signingKey('platform-oidc-main')
    const download = issuerServing({ keys: [current.jwk] })

    await verifyOidcJwt(await current.sign(), { issuer: ISSUER })
    expect(download).toHaveBeenCalledOnce()
    expect((await stored())?.value.jwks.keys).toHaveLength(1)

    newProcess()
    const { payload } = await verifyOidcJwt(await current.sign(), { issuer: ISSUER })

    expect(payload.org).toBe('org_sales')
    expect(download).toHaveBeenCalledOnce()
  })

  it('keys the cache by a digest of the issuer, not the issuer URL', () => {
    expect(oidcJwksKey(ISSUER).path).toMatch(/^cache:oidc-jwks\/[A-Za-z0-9_-]{43}$/)
  })

  it('keeps a stored key set only as long as its download is fresh: ten minutes from the download', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-04T12:00:00Z'), toFake: ['Date'] })
    const downloadedAt = Date.now()
    const current = await signingKey('platform-oidc-main')
    const download = issuerServing({ keys: [current.jwk] })
    await verifyOidcJwt(await current.sign(), { issuer: ISSUER })
    expect(await stored()).toMatchObject({ value: { uat: downloadedAt }, expiresAt: downloadedAt + TEN_MINUTES })

    vi.setSystemTime(downloadedAt + TEN_MINUTES - 1_000)
    newProcess()
    await verifyOidcJwt(await current.sign(), { issuer: ISSUER })
    expect(download).toHaveBeenCalledOnce()
    // Served, not downloaded: the copy still carries the first download's time.
    expect((await stored())?.value.uat).toBe(downloadedAt)

    vi.setSystemTime(downloadedAt + TEN_MINUTES)
    expect(await stored()).toBeNull()
    newProcess()
    await verifyOidcJwt(await current.sign(), { issuer: ISSUER })
    expect(download).toHaveBeenCalledTimes(2)
    expect((await stored())?.value.uat).toBe(downloadedAt + TEN_MINUTES)
  })

  it('downloads the keys again for a token signed with a key the stored set lacks, and stores the new set', async () => {
    const old = await signingKey('platform-oidc-2026-10')
    const rotated = await signingKey('platform-oidc-2026-11')
    const uat = Date.now() - 60_000
    await appState().set(oidcJwksKey(ISSUER), { jwks: { keys: [old.jwk] }, uat }, { expiry: { at: uat + TEN_MINUTES } })
    const download = issuerServing({ keys: [old.jwk, rotated.jwk] })

    await verifyOidcJwt(await rotated.sign(), { issuer: ISSUER })

    expect(download).toHaveBeenCalledOnce()
    expect((await stored())?.value.jwks.keys.map((key) => key.kid)).toEqual([
      'platform-oidc-2026-10',
      'platform-oidc-2026-11',
    ])
  })

  it('downloads the keys when the cache cannot be read, and stores them', async () => {
    const current = await signingKey('platform-oidc-main')
    const download = issuerServing({ keys: [current.jwk] })
    vi.spyOn(appState(), 'get').mockRejectedValueOnce(new Error('AppState unavailable'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { payload } = await verifyOidcJwt(await current.sign(), { issuer: ISSUER })

    expect(payload.org).toBe('org_sales')
    expect(download).toHaveBeenCalledOnce()
    expect((await stored())?.value.jwks.keys).toHaveLength(1)
  })

  it('fails clearly when the entry point did not initialize AppState', async () => {
    await closeAppState()
    const current = await signingKey('platform-oidc-main')
    issuerServing({ keys: [current.jwk] })

    await expect(verifyOidcJwt(await current.sign(), { issuer: ISSUER })).rejects.toThrow('AppState is not initialized')
  })
})
