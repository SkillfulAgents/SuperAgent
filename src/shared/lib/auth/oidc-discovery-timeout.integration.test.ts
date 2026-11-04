/** Real HTTP stalls must isolate SSO from password and installed-client auth. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Hono } from 'hono'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { background, backgroundSettled } from '../background'
import type { AppDatabase } from '../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import { createOidcTestServer, responseCookies, type OidcTestServer } from './testing/oidc-server'

let database: TestDatabase
let testDb: AppDatabase
let authority: Awaited<ReturnType<typeof createFaultingAuthority>>
let healthy: OidcTestServer
let app: Hono

vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/config/settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/config/settings')>(),
  getSettings: () => ({ auth: { requireAdminApproval: false, maxConcurrentSessions: 30 } }),
}))

import { getAuth, resetAuth } from './index'
import { handleAuthRequest } from './handler'
import mobilePairing from '../../../api/routes/mobile-pairing'
import tokenExchange from '../../../api/routes/token-exchange'
import { MobileSessionResponseSchema, type MobileSessionResponse } from './mobile-pairing-schema'
import { JWT_BEARER_GRANT_TYPE, TokenExchangeSuccessSchema } from './token-exchange-schema'

const BASE = 'http://localhost:47891'
const PASSWORD = 'DiscoveryIsolation123!'
const EMAIL = 'discovery-isolation@example.com'
const ORG = 'org_oidc_test'
const FAST_LIMIT_MS = 3_000
const credentialsSchema = z.object({ token: z.string(), user: z.object({ id: z.string() }) })
const authorizeSchema = z.object({ url: z.string().url() })
const jwksSchema = z.object({ keys: z.array(z.record(z.string(), z.unknown())) })
type Stall = 'headers' | 'body'

/** Keep discovery, JWT signatures, JWKS and the PKCE exchange on real sockets. */
async function createFaultingAuthority() {
  const oidc = await createOidcTestServer()
  const upstream = oidc.state.issuer
  const signing = await generateKeyPair('RS256')
  const grantKey = { ...await exportJWK(signing.publicKey), kid: 'grant-key', alg: 'RS256', use: 'sig' }
  const state = {
    mode: 'headers' as Stall | 'healthy', discoveryRequests: 0, abortedDiscovery: 0,
    jwksRequests: 0, failures: [] as string[],
  }

  async function serve(request: IncomingMessage, response: ServerResponse) {
    const path = request.url ?? '/'
    if (path === '/.well-known/openid-configuration') {
      state.discoveryRequests++
      if (state.mode !== 'healthy') {
        response.on('close', () => { if (!response.writableEnded) state.abortedDiscovery++ })
        if (state.mode === 'body') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.flushHeaders()
          response.write('{"issuer":')
        }
        // Deliberately never finish: only the caller's abort closes the socket.
        return
      }
    }
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const upstreamResponse = await fetch(`${upstream}${path}`, {
      method: request.method, redirect: 'manual',
      headers: { 'content-type': request.headers['content-type'] ?? 'application/json' },
      ...(body ? { body } : {}),
    })
    if (path === '/jwks') {
      state.jwksRequests++
      const jwks = jwksSchema.parse(await upstreamResponse.json())
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ keys: [...jwks.keys, grantKey] }))
      return
    }
    response.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers))
    response.end(await upstreamResponse.text())
  }

  const server = createServer((request, response) => {
    background(serve(request, response).catch((error: unknown) => {
      state.failures.push(error instanceof Error ? error.message : String(error))
      response.writeHead(500).end()
    }), { name: 'discovery-timeout-test.http' })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  oidc.state.issuer = `http://127.0.0.1:${address.port}`
  oidc.state.acceptedRedirectUri = `${BASE}/api/auth/oauth2/callback/platform`

  return {
    state, oidc,
    signGrant: () => new SignJWT({
      sub: 'platform-installed-user', org_id: ORG, email: 'installed@example.com',
      email_verified: true, name: 'Installed User', jti: randomUUID(),
    }).setProtectedHeader({ alg: 'RS256', kid: grantKey.kid, typ: 'deployment-assertion+jwt' })
      .setIssuer(oidc.state.issuer).setAudience(BASE).setIssuedAt().setExpirationTime('2m')
      .sign(signing.privateKey),
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await oidc.close()
    },
  }
}

async function within<T>(operation: T | Promise<T>, limit = FAST_LIMIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Auth operation exceeded ${limit}ms`)), limit)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function request(path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.request(`${BASE}/api/auth/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

async function passwordSession(signUp = false) {
  const response = await within(request(signUp ? 'sign-up/email' : 'sign-in/email', {
    email: EMAIL, password: PASSWORD, ...(signUp ? { name: 'Password User' } : {}),
  }, { origin: BASE }))
  expect(response.status).toBe(200)
  return { ...credentialsSchema.parse(await response.json()), cookie: responseCookies(response) }
}

async function bearerSession(token: string, userId?: string) {
  const response = await within(request('get-session', undefined, { authorization: `Bearer ${token}` }))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ user: { id: userId ?? expect.any(String) } })
}

async function pairMobile(cookie: string) {
  const minted = await within(request('mobile/pairing-token', {}, { cookie, origin: BASE }))
  expect(minted.status).toBe(200)
  const { token } = z.object({ token: z.string() }).parse(await minted.json())
  const redeemed = await within(request('mobile/redeem', { token, platform: 'ios', deviceName: 'iPhone' }))
  expect(redeemed.status).toBe(200)
  return MobileSessionResponseSchema.parse(await redeemed.json())
}

async function renewMobile(previous: MobileSessionResponse) {
  // Match URLSession's actual contract: no Cookie and no Origin header.
  const response = await within(request('mobile/renew', { refreshToken: previous.refreshToken }))
  expect(response.status).toBe(200)
  const renewed = MobileSessionResponseSchema.parse(await response.json())
  expect(renewed.deviceId).toBe(previous.deviceId)
  expect(renewed.refreshToken).not.toBe(previous.refreshToken)
  await bearerSession(renewed.token, previous.user.id)
  return renewed
}

async function exchangeGrant() {
  const assertion = await authority.signGrant()
  const response = await within(app.request(`${BASE}/api/auth/token/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT_TYPE, assertion }),
  }))
  expect(response.status).toBe(200)
  const result = TokenExchangeSuccessSchema.parse(await response.json())
  await bearerSession(result.access_token)
}

function startSso(provider = 'platform') {
  return request('sign-in/social', { provider, callbackURL: `${BASE}/` }, { origin: BASE })
}

async function completeSso(provider = 'platform') {
  const start = await within(startSso(provider))
  expect(start.status).toBe(200)
  const { url } = authorizeSchema.parse(await start.json())
  const redirect = await within(fetch(url, { redirect: 'manual' }))
  expect(redirect.status).toBe(302)
  const response = await within(app.request(redirect.headers.get('location')!, {
    headers: { cookie: responseCookies(start) },
  }))
  expect(response.status).toBe(302)
  expect(response.headers.get('location')).toBe(`${BASE}/`)
  expect(responseCookies(response)).toContain('session_token=')
  const session = await within(request('get-session', undefined, { cookie: responseCookies(response) }))
  expect(session.status).toBe(200)
  expect(await session.json()).toMatchObject({ user: { email: 'ada@example.com' } })
}

beforeEach(async () => {
  authority = await createFaultingAuthority()
  healthy = await createOidcTestServer()
  healthy.state.acceptedRedirectUri = `${BASE}/api/auth/oauth2/callback/secondary`
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('BETTER_AUTH_SECRET', 'discovery-isolation-secret-0123456789abcdef0123456789abcdef')
  vi.stubEnv('TRUSTED_ORIGINS', BASE)
  vi.stubEnv('PLATFORM_TOKEN', `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ orgId: ORG })).toString('base64url')}.sig`)
  vi.stubEnv('AUTH_PROVIDERS_JSON', JSON.stringify([
    { id: 'platform', type: 'oidc', issuer: authority.oidc.state.issuer, clientId: 'test-client' },
    { id: 'secondary', type: 'oidc', issuer: healthy.state.issuer, clientId: 'test-client' },
  ]))
  database = await createTestDatabase()
  testDb = database.db
  app = new Hono()
  app.route('/api/auth/mobile', mobilePairing)
  app.route('/api/auth/token', tokenExchange)
  app.all('/api/auth/*', c => handleAuthRequest(c.req.raw))
  resetAuth()
})

afterEach(async () => {
  resetAuth()
  await authority?.close()
  await healthy?.close()
  await backgroundSettled()
  await database?.close()
  vi.unstubAllEnvs()
  expect(authority.state.failures).toEqual([])
  expect(authority.oidc.state.failures).toEqual([])
  expect(healthy.state.failures).toEqual([])
})

describe.each(['headers', 'body'] as const)('OIDC discovery with stalled %s', (stall) => {
  it('keeps cold and reset password, bearer, mobile and token-exchange requests independent of discovery', async () => {
    authority.state.mode = stall
    const signedUp = await passwordSession(true)
    let mobile = await pairMobile(signedUp.cookie)
    for (const reset of [false, true]) {
      if (reset) resetAuth()
      const password = await passwordSession()
      if (reset) resetAuth()
      await bearerSession(password.token, signedUp.user.id)
      const cookieSession = await within(request('get-session', undefined, { cookie: password.cookie }))
      expect(await cookieSession.json()).toMatchObject({ user: { id: signedUp.user.id } })
      if (reset) resetAuth()
      mobile = await renewMobile(mobile)
      if (reset) resetAuth()
      await exchangeGrant()
    }
    expect(authority.state.discoveryRequests).toBe(0)
    expect(healthy.state.discoveryRequests).toBe(0)
    expect(authority.state.jwksRequests).toBeGreaterThan(0)
  })

  it('bounds a stalled SSO request, isolates concurrent auth, then recovers on a later request', async () => {
    authority.state.mode = stall
    const password = await passwordSession(true)
    const mobile = await pairMobile(password.cookie)
    resetAuth()
    const started = Date.now()
    const pendingSso = within(startSso(), 15_000)
    await vi.waitFor(() => expect(authority.state.discoveryRequests).toBe(1), { timeout: FAST_LIMIT_MS, interval: 10 })
    const concurrentSso = within(startSso(), 15_000)

    await bearerSession(password.token, password.user.id)
    await passwordSession()
    await renewMobile(mobile)
    await exchangeGrant()
    await completeSso('secondary')
    expect(Date.now() - started).toBeLessThan(FAST_LIMIT_MS)
    expect(healthy.state.discoveryRequests).toBe(1)
    expect(authority.state.discoveryRequests).toBe(1)

    for (const failed of await Promise.all([pendingSso, concurrentSso])) {
      expect(failed.status).toBe(404)
      expect(await failed.json()).toMatchObject({ code: 'PROVIDER_NOT_FOUND' })
    }
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(authority.state.discoveryRequests).toBe(1)
    await vi.waitFor(() => expect(authority.state.abortedDiscovery).toBe(1))
    expect(authority.oidc.state.tokenExchanges).toHaveLength(0)

    authority.state.mode = 'healthy'
    await completeSso()
    expect(authority.state.discoveryRequests).toBe(2)
    expect(authority.oidc.state.tokenExchanges).toHaveLength(1)
    // Reset must create independent pending state and rediscover on first SSO.
    resetAuth()
    await within(getAuth().$context)
    expect(authority.state.discoveryRequests).toBe(2)
    await completeSso()
    expect(authority.state.discoveryRequests).toBe(3)
  }, 20_000)
})
