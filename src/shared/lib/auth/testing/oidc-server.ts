import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose'
import { z } from 'zod'
import { background, backgroundSettled } from '../../background'

const authorizationSchema = z.object({
  client_id: z.literal('test-client'),
  redirect_uri: z.string().url(),
  response_type: z.literal('code'),
  state: z.string().min(1),
  nonce: z.string().min(1).optional(),
  code_challenge: z.string().min(1),
  code_challenge_method: z.literal('S256'),
})
const tokenRequestSchema = z.object({
  grant_type: z.literal('authorization_code'),
  client_id: z.literal('test-client'),
  code: z.string(),
  redirect_uri: z.string().url(),
  code_verifier: z.string().min(43),
})
const startResponseSchema = z.object({ url: z.string().url() })
type Authorization = z.infer<typeof authorizationSchema>

/** A real OIDC authority: signed tokens, HTTP discovery/JWKS and PKCE-bound codes. */
export async function createOidcTestServer() {
  const pair = await generateKeyPair('RS256')
  const wrongPair = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'oidc-test-key', alg: 'RS256', use: 'sig' }
  const codes = new Map<string, Authorization>()
  const state = {
    issuer: '',
    acceptedRedirectUri: '',
    discoveryUnavailable: false,
    omitJwks: false,
    wrongSigningKey: false,
    omitNonce: false,
    claims: {} as JWTPayload,
    profile: {
      sub: 'sub_member_one', name: 'Ada Lovelace', email: 'ada@example.com',
      email_verified: true, picture: 'https://example.com/first.png',
      'https://platform.skillfulagents.dev/claims/org_id': 'org_oidc_test',
      'https://platform.skillfulagents.dev/claims/role': 'member',
    } as JWTPayload,
    authorizations: [] as Authorization[],
    tokenExchanges: [] as z.infer<typeof tokenRequestSchema>[],
    failures: [] as string[],
    discoveryRequests: 0,
    jwksRequests: 0,
  }

  async function idToken(nonce?: string) {
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT({
      ...state.profile, iss: state.issuer, aud: 'test-client', iat: now, exp: now + 300,
      ...(state.omitNonce ? {} : { nonce }), ...state.claims,
    }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
      .sign(state.wrongSigningKey ? wrongPair.privateKey : pair.privateKey)
  }

  function json(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  }

  async function serve(request: IncomingMessage, response: ServerResponse) {
    // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- The server records and rejects malformed fixture requests below.
    const url = new URL(request.url ?? '/', state.issuer)
    if (url.pathname === '/.well-known/openid-configuration') {
      state.discoveryRequests++
      if (state.discoveryUnavailable) return json(response, 503, { error: 'temporarily_unavailable' })
      return json(response, 200, {
        issuer: state.issuer,
        authorization_endpoint: `${state.issuer}/authorize`,
        token_endpoint: `${state.issuer}/token`,
        userinfo_endpoint: `${state.issuer}/userinfo`,
        end_session_endpoint: `${state.issuer}/logout`,
        ...(state.omitJwks ? {} : { jwks_uri: `${state.issuer}/jwks` }),
        id_token_signing_alg_values_supported: ['RS256'],
        response_types_supported: ['code'], subject_types_supported: ['public'],
        token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
      })
    }
    if (url.pathname === '/jwks') {
      state.jwksRequests++
      return json(response, 200, { keys: [jwk] })
    }
    if (url.pathname === '/authorize') {
      const authorization = authorizationSchema.parse(Object.fromEntries(url.searchParams))
      assert.equal(authorization.redirect_uri, state.acceptedRedirectUri)
      state.authorizations.push(authorization)
      const code = randomUUID()
      codes.set(code, authorization)
      // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- Validated by authorizationSchema and the exact registered-URI assertion.
      const redirect = new URL(authorization.redirect_uri)
      redirect.searchParams.set('code', code)
      redirect.searchParams.set('state', authorization.state)
      redirect.searchParams.set('iss', state.issuer)
      response.writeHead(302, { location: redirect.toString() }).end()
      return
    }
    if (url.pathname === '/token') {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const tokenRequest = tokenRequestSchema.parse(Object.fromEntries(new URLSearchParams(body)))
      const authorization = codes.get(tokenRequest.code)
      assert.ok(authorization, 'Authorization code must be valid and single use')
      codes.delete(tokenRequest.code)
      assert.equal(tokenRequest.redirect_uri, authorization.redirect_uri, 'Token exchange must use the registered callback')
      assert.equal(createHash('sha256').update(tokenRequest.code_verifier).digest('base64url'), authorization.code_challenge)
      state.tokenExchanges.push(tokenRequest)
      return json(response, 200, {
        access_token: 'test-access', token_type: 'Bearer', expires_in: 3600,
        id_token: await idToken(authorization.nonce), scope: 'openid profile email',
      })
    }
    if (url.pathname === '/userinfo') return json(response, 200, state.profile)
    return json(response, 404, { error: 'not_found' })
  }

  const server = createServer((request, response) => {
    background(serve(request, response).catch((error: unknown) => {
      state.failures.push(error instanceof Error ? error.message : String(error))
      json(response, 400, { error: 'invalid_request' })
    }), { name: 'oidc-test.http' })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  state.issuer = `http://127.0.0.1:${address.port}`
  return {
    state,
    idToken,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await backgroundSettled()
    },
  }
}

export type OidcTestServer = Awaited<ReturnType<typeof createOidcTestServer>>
export type AuthHandler = (request: Request) => Promise<Response>

export function responseCookies(response: Response): string {
  return response.headers.getSetCookie()
    .filter(value => !/max-age=0(?:;|$)/i.test(value))
    .map(value => value.split(';')[0]).join('; ')
}

/** Start through the actual sign-in endpoint and follow the authority's redirect. */
export async function beginOidcLogin(handler: AuthHandler, base: string) {
  const start = await handler(new Request(`${base}/api/auth/sign-in/social`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ provider: 'platform', callbackURL: `${base}/`, errorCallbackURL: `${base}/login-error` }),
  }))
  assert.equal(start.status, 200, await start.clone().text())
  const authorize = startResponseSchema.parse(await start.json()).url
  // The authority also serves the 1.6 upgrade fixture, which predates nonce
  // binding. Every login started by the upgraded app must provide one.
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- startResponseSchema validates this as a URL.
  assert.ok(new URL(authorize).searchParams.get('nonce'), 'Better Auth 1.7 must bind the ID token to this login')
  const authorization = await fetch(authorize, { redirect: 'manual' })
  assert.equal(authorization.status, 302, await authorization.clone().text())
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- A malformed redirect must fail the calling test.
  return { callback: new URL(authorization.headers.get('location')!), cookie: responseCookies(start) }
}

export async function completeOidcLogin(handler: AuthHandler, base: string) {
  const { callback, cookie } = await beginOidcLogin(handler, base)
  return handler(new Request(callback, { headers: { cookie } }))
}
