import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT, type ExportedJWKSCache } from 'jose'
import { setOidcJwksStore, verifyOidcJwt, type OidcJwksStore } from './oidc-jwt'

const ISSUER = 'https://auth.example.com'

async function signingKey(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }
  const sign = () =>
    new SignJWT({ org: 'org_sales' }).setProtectedHeader({ alg: 'RS256', kid }).setIssuer(ISSUER).setIssuedAt().setExpirationTime('5m').sign(privateKey)
  return { jwk, sign }
}

function memoryStore(): OidcJwksStore & { keys: Map<string, ExportedJWKSCache> } {
  const keys = new Map<string, ExportedJWKSCache>()
  return {
    keys,
    get: async (issuer) => structuredClone(keys.get(issuer) ?? null),
    put: async (issuer, set) => {
      keys.set(issuer, structuredClone(set))
    },
  }
}

/** The issuer's /jwks, serving whatever keys it holds now; counts its downloads. */
function issuerServing(published: { keys: object[] }) {
  const download = vi.fn(async () => Response.json(published))
  vi.stubGlobal('fetch', download)
  return download
}

afterEach(() => {
  setOidcJwksStore(null)
  vi.unstubAllGlobals()
})

describe('verifyOidcJwt with a stored key set', () => {
  it('verifies in a new process with the stored keys, without downloading them again', async () => {
    const current = await signingKey('platform-oidc-main')
    const download = issuerServing({ keys: [current.jwk] })
    const store = memoryStore()

    setOidcJwksStore(store, { maxAgeMs: 24 * 60 * 60_000 })
    await verifyOidcJwt(await current.sign(), { issuer: ISSUER })
    expect(download).toHaveBeenCalledOnce()
    expect(store.keys.get(ISSUER)?.jwks.keys).toHaveLength(1)

    // A new process: nothing in memory, the store kept.
    setOidcJwksStore(store, { maxAgeMs: 24 * 60 * 60_000 })
    const { payload } = await verifyOidcJwt(await current.sign(), { issuer: ISSUER })

    expect(payload.org).toBe('org_sales')
    expect(download).toHaveBeenCalledOnce()
  })

  it('downloads the keys again for a token signed with a key the stored set lacks, and stores the new set', async () => {
    const old = await signingKey('platform-oidc-2026-10')
    const rotated = await signingKey('platform-oidc-2026-11')
    const store = memoryStore()
    store.keys.set(ISSUER, { jwks: { keys: [old.jwk] }, uat: Date.now() - 60_000 })
    const download = issuerServing({ keys: [old.jwk, rotated.jwk] })

    setOidcJwksStore(store, { maxAgeMs: 24 * 60 * 60_000 })
    await verifyOidcJwt(await rotated.sign(), { issuer: ISSUER })

    expect(download).toHaveBeenCalledOnce()
    expect(store.keys.get(ISSUER)?.jwks.keys.map((key) => key.kid)).toEqual(['platform-oidc-2026-10', 'platform-oidc-2026-11'])
  })
})
