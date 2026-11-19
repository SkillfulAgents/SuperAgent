import {
  createRemoteJWKSet,
  jwksCache,
  jwtVerify,
  type ExportedJWKSCache,
  type JWKSCacheInput,
  type JWTPayload,
  type JWTVerifyResult,
} from 'jose'
import { z } from 'zod'
import { appState, defineNamespace, digestKeyPart } from '@shared/lib/app-state'

type RemoteJwksResolver = ReturnType<typeof createRemoteJWKSet>

/** How long a key set is used before jose fetches it again (jose's default). A key id it lacks is fetched sooner. */
const JWKS_MAX_AGE_MS = 10 * 60_000

/**
 * Downloaded key sets, so a process that starts often verifies without
 * downloading them again. A copy keeps jose's `uat` (when the set was
 * downloaded) and expires `JWKS_MAX_AGE_MS` after it, so it is never used
 * longer than the download it came from. It holds what the issuer publishes:
 * public keys.
 */
const oidcJwksCache = defineNamespace({
  name: 'cache:oidc-jwks',
  consistency: 'eventual',
  // Typed as jose's own: the schema checks the shape, and jose checks each key
  // as it imports it. Loose, so a JWK keeps every member (n, e, crv, x, ...).
  schema: z.object({
    jwks: z.object({ keys: z.array(z.looseObject({ kty: z.string() })) }),
    uat: z.number(),
  }) as z.ZodType<ExportedJWKSCache>,
  expiry: { ttlMs: JWKS_MAX_AGE_MS, onUpdate: 'reset' },
})

/** The cache key of an issuer's key set. */
export const oidcJwksKey = (issuer: string) => oidcJwksCache.key(digestKeyPart(issuer))

interface IssuerKeys {
  resolver: RemoteJwksResolver
  /** jose's cache of the key set, read from and written back to the AppState cache. */
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

/**
 * The key set comes from the AppState cache first, so a host whose processes start often (its
 * AppState outlives the process) verifies without fetching the keys in each new process.
 */
async function issuerKeys(issuer: string): Promise<IssuerKeys> {
  let jwksUrl: URL
  try {
    jwksUrl = new URL('/jwks', issuer)
  } catch (error) {
    throw new Error(`Invalid issuer URL for JWKS: ${issuer}`, { cause: error })
  }
  // The cache only saves a download: if it fails, jose fetches the keys.
  const stored: JWKSCacheInput =
    (
      await appState()
        .get(oidcJwksKey(issuer))
        .catch((error: unknown) => {
          console.warn('[oidc-jwt] Failed to read the stored issuer key set:', error)
          return null
        })
    )?.value ?? {}
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
      await appState()
        .set(oidcJwksKey(options.issuer), stored, { expiry: { at: stored.uat + JWKS_MAX_AGE_MS } })
        .catch((error: unknown) => {
          console.warn('[oidc-jwt] Failed to store the issuer key set:', error)
        })
    }
  }
}
