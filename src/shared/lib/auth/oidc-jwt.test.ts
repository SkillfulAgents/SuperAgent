import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT, type ExportedJWKSCache } from 'jose'
import { InMemoryKVStore, setKVCacheStore } from '@shared/lib/kv-cache/kv-store'
import { _setOidcJwksResolverForTest, verifyOidcJwt } from './oidc-jwt'

const ISSUER = 'https://auth.example.com'
const KEY = `oidc-jwks:${ISSUER}`

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

/** A new process: nothing in memory, the KV cache store kept. */
const newProcess = () => _setOidcJwksResolverForTest(null)

let store: InMemoryKVStore

beforeEach(() => {
  store = new InMemoryKVStore()
  setKVCacheStore(store)
  newProcess()
})

afterEach(() => {
  setKVCacheStore(new InMemoryKVStore())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('verifyOidcJwt with the KV cache store', () => {
  it('verifies in a new process with the stored keys, without downloading them again', async () => {
    const current = await signingKey('platform-oidc-main')
    const download = issuerServing({ keys: [current.jwk] })

    await verifyOidcJwt(await current.sign(), { issuer: ISSUER })
    expect(download).toHaveBeenCalledOnce()
    expect((await store.get<ExportedJWKSCache>(KEY))?.jwks.keys).toHaveLength(1)

    newProcess()
    const { payload } = await verifyOidcJwt(await current.sign(), { issuer: ISSUER })

    expect(payload.org).toBe('org_sales')
    expect(download).toHaveBeenCalledOnce()
  })

  it('downloads the keys again for a token signed with a key the stored set lacks, and stores the new set', async () => {
    const old = await signingKey('platform-oidc-2026-10')
    const rotated = await signingKey('platform-oidc-2026-11')
    await store.put(KEY, { jwks: { keys: [old.jwk] }, uat: Date.now() - 60_000 })
    const download = issuerServing({ keys: [old.jwk, rotated.jwk] })

    await verifyOidcJwt(await rotated.sign(), { issuer: ISSUER })

    expect(download).toHaveBeenCalledOnce()
    expect((await store.get<ExportedJWKSCache>(KEY))?.jwks.keys.map((key) => key.kid)).toEqual([
      'platform-oidc-2026-10',
      'platform-oidc-2026-11',
    ])
  })

  it('downloads the keys when the store cannot be read, and stores them', async () => {
    const current = await signingKey('platform-oidc-main')
    const download = issuerServing({ keys: [current.jwk] })
    vi.spyOn(store, 'get').mockRejectedValueOnce(new Error('KV unavailable'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { payload } = await verifyOidcJwt(await current.sign(), { issuer: ISSUER })

    expect(payload.org).toBe('org_sales')
    expect(download).toHaveBeenCalledOnce()
    expect((await store.get<ExportedJWKSCache>(KEY))?.jwks.keys).toHaveLength(1)
  })
})
