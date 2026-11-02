import {
  createRemoteJWKSet,
  jwksCache,
  jwtVerify,
  type ExportedJWKSCache,
  type JWKSCacheInput,
  type JWTPayload,
  type JWTVerifyResult,
} from 'jose'

type RemoteJwksResolver = ReturnType<typeof createRemoteJWKSet>

/** Where a host keeps each issuer's key set between processes. */
export interface OidcJwksStore {
  get(issuer: string): Promise<ExportedJWKSCache | null>
  put(issuer: string, keys: ExportedJWKSCache): Promise<void>
}

interface IssuerKeys {
  resolver: RemoteJwksResolver
  /** jose's cache of the key set, read from and written back to the store; null without one. */
  stored: JWKSCacheInput | null
}

// JWKS resolver cache, one per issuer URL.
const jwksByIssuer = new Map<string, Promise<IssuerKeys>>()
// Test-only override; lets tests swap in a local JWKS resolver.
let injectedJwksResolver: RemoteJwksResolver | null = null
let jwksStore: { store: OidcJwksStore; maxAgeMs: number } | null = null

export function _setOidcJwksResolverForTest(resolver: RemoteJwksResolver | null): void {
  injectedJwksResolver = resolver
  jwksByIssuer.clear()
}

/**
 * Keeps each issuer's key set in `store` too, for a host whose processes start often: a new
 * process verifies with the stored keys instead of fetching them. Stored keys are used for
 * `maxAgeMs` (default 10 minutes); a key id they lack still triggers a fetch. `null` keeps the keys
 * in memory only.
 */
export function setOidcJwksStore(store: OidcJwksStore | null, options: { maxAgeMs?: number } = {}): void {
  jwksStore = store ? { store, maxAgeMs: options.maxAgeMs ?? 10 * 60_000 } : null
  jwksByIssuer.clear()
}

async function issuerKeys(issuer: string): Promise<IssuerKeys> {
  let jwksUrl: URL
  try {
    jwksUrl = new URL('/jwks', issuer)
  } catch (error) {
    throw new Error(`Invalid issuer URL for JWKS: ${issuer}`, { cause: error })
  }
  if (!jwksStore) return { resolver: createRemoteJWKSet(jwksUrl), stored: null }
  const stored: JWKSCacheInput = (await jwksStore.store.get(issuer)) ?? {}
  return {
    resolver: createRemoteJWKSet(jwksUrl, { cacheMaxAge: jwksStore.maxAgeMs, [jwksCache]: stored }),
    stored,
  }
}

function keysForIssuer(issuer: string): Promise<IssuerKeys> {
  let keys = jwksByIssuer.get(issuer)
  if (!keys) {
    keys = issuerKeys(issuer)
    jwksByIssuer.set(issuer, keys)
    keys.catch(() => jwksByIssuer.delete(issuer))
  }
  return keys
}

export interface VerifyOidcJwtOptions {
  issuer: string
  /**
   * Accepted audience. jose compares the `aud` claim byte-for-byte and accepts
   * any member of a multi-valued claim, so a caller needing a different rule
   * (a canonical comparison, or a single-valued `aud`) omits this and enforces
   * that rule on the returned payload instead. Omitting it means jose does not
   * check `aud` at all — the caller then *must*.
   */
  audience?: string | string[]
  algorithms?: string[]
  typ?: string
}

export async function verifyOidcJwt(
  token: string,
  options: VerifyOidcJwtOptions,
): Promise<JWTVerifyResult<JWTPayload>> {
  const verify = (resolver: RemoteJwksResolver) =>
    jwtVerify(token, resolver, {
      issuer: options.issuer,
      audience: options.audience,
      algorithms: options.algorithms,
      typ: options.typ,
    })
  if (injectedJwksResolver) return verify(injectedJwksResolver)
  const { resolver, stored } = await keysForIssuer(options.issuer)
  const fetchedAt = stored && 'uat' in stored ? stored.uat : undefined
  try {
    return await verify(resolver)
  } finally {
    // jose updated its cache in place when it fetched the key set: keep the new one.
    if (jwksStore && stored && 'uat' in stored && stored.uat !== fetchedAt) {
      await jwksStore.store.put(options.issuer, stored).catch((error) => {
        console.warn('[oidc-jwt] Failed to store the issuer key set:', error)
      })
    }
  }
}
