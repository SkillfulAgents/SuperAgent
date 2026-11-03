import {
  createRemoteJWKSet,
  jwksCache,
  jwtVerify,
  type ExportedJWKSCache,
  type JWKSCacheInput,
  type JWTPayload,
  type JWTVerifyResult,
} from 'jose'
import { getKVCacheStore } from '@shared/lib/kv-cache/kv-store'

type RemoteJwksResolver = ReturnType<typeof createRemoteJWKSet>

/** How long a key set is used before jose fetches it again (jose's default). A key id it lacks is fetched sooner. */
const JWKS_MAX_AGE_MS = 10 * 60_000

interface IssuerKeys {
  resolver: RemoteJwksResolver
  /** jose's cache of the key set, read from and written back to the KV cache store. */
  stored: JWKSCacheInput
}

// JWKS resolver cache, one per issuer URL.
const jwksByIssuer = new Map<string, Promise<IssuerKeys>>()
// Test-only override; lets tests swap in a local JWKS resolver.
let injectedJwksResolver: RemoteJwksResolver | null = null

export function _setOidcJwksResolverForTest(resolver: RemoteJwksResolver | null): void {
  injectedJwksResolver = resolver
  jwksByIssuer.clear()
}

const storeKey = (issuer: string) => `oidc-jwks:${issuer}`

/**
 * The key set comes from the KV cache store first, so a host whose processes start often (its
 * store outlives the process) verifies without fetching the keys in each new process.
 */
async function issuerKeys(issuer: string): Promise<IssuerKeys> {
  let jwksUrl: URL
  try {
    jwksUrl = new URL('/jwks', issuer)
  } catch (error) {
    throw new Error(`Invalid issuer URL for JWKS: ${issuer}`, { cause: error })
  }
  // The store only saves a download: if it fails, jose fetches the keys.
  const stored: JWKSCacheInput =
    (await getKVCacheStore()
      .get<ExportedJWKSCache>(storeKey(issuer))
      .catch((error) => {
        console.warn('[oidc-jwt] Failed to read the stored issuer key set:', error)
        return null
      })) ?? {}
  return {
    resolver: createRemoteJWKSet(jwksUrl, { cacheMaxAge: JWKS_MAX_AGE_MS, [jwksCache]: stored }),
    stored,
  }
}

/** jose's cache once it holds a key set (it starts as `{}`). */
function holdsKeys(cache: JWKSCacheInput): cache is ExportedJWKSCache {
  return 'uat' in cache
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
  const fetchedAt = holdsKeys(stored) ? stored.uat : undefined
  try {
    return await verify(resolver)
  } finally {
    // jose updated its cache in place when it fetched the key set: keep the new one.
    if (holdsKeys(stored) && stored.uat !== fetchedAt) {
      await getKVCacheStore()
        .put(storeKey(options.issuer), stored, JWKS_MAX_AGE_MS)
        .catch((error) => {
          console.warn('[oidc-jwt] Failed to store the issuer key set:', error)
        })
    }
  }
}
