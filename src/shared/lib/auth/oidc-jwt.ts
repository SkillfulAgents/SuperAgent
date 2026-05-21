import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyResult } from 'jose'

type RemoteJwksResolver = ReturnType<typeof createRemoteJWKSet>

// JWKS resolver cache, one per issuer URL.
const jwksByIssuer = new Map<string, RemoteJwksResolver>()
// Test-only override; lets tests swap in a local JWKS resolver.
let injectedJwksResolver: RemoteJwksResolver | null = null

export function _setOidcJwksResolverForTest(resolver: RemoteJwksResolver | null): void {
  injectedJwksResolver = resolver
  jwksByIssuer.clear()
}

function getJwksResolverForIssuer(issuer: string): RemoteJwksResolver {
  if (injectedJwksResolver) return injectedJwksResolver
  let resolver = jwksByIssuer.get(issuer)
  if (!resolver) {
    let jwksUrl: URL
    try {
      jwksUrl = new URL('/jwks', issuer)
    } catch (error) {
      throw new Error(`Invalid issuer URL for JWKS: ${issuer}`, { cause: error })
    }
    resolver = createRemoteJWKSet(jwksUrl)
    jwksByIssuer.set(issuer, resolver)
  }
  return resolver
}

export interface VerifyOidcJwtOptions {
  issuer: string
  audience: string
  algorithms?: string[]
  typ?: string
}

export async function verifyOidcJwt(
  token: string,
  options: VerifyOidcJwtOptions,
): Promise<JWTVerifyResult<JWTPayload>> {
  return jwtVerify(token, getJwksResolverForIssuer(options.issuer), {
    issuer: options.issuer,
    audience: options.audience,
    algorithms: options.algorithms,
    typ: options.typ,
  })
}
