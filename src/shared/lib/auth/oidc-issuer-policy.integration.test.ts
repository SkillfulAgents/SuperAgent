/** Issuer policy against real discovery, signed tokens and both callback transports. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { authAccount, authSession, user } from '../db/schema'
import {
  beginOidcLogin, createOidcTestServer, responseCookies, type OidcTestServer,
} from './testing/oidc-server'

let database: TestDatabase
let testDb: AppDatabase
let oidc: OidcTestServer

vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/config/settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/config/settings')>(),
  getSettings: () => ({ auth: { requireAdminApproval: false } }),
}))

import { getAuth, resetAuth } from './index'
import { handleAuthRequest } from './handler'

const BASE = 'http://localhost:47891'
const WRONG_ISSUER = 'https://different-issuer.example.com'

function configureProvider(explicitIssuer: string | undefined) {
  vi.stubEnv('AUTH_PROVIDERS_JSON', JSON.stringify([{
    id: 'platform', type: 'oidc', discoveryUrl: `${oidc.state.issuer}/.well-known/openid-configuration`,
    issuer: explicitIssuer, clientId: 'test-client', scopes: ['openid', 'profile', 'email'],
  }]))
}

async function signIn(mode: 'redirect' | 'id-token') {
  return handleAuthRequest(new Request(`${BASE}/api/auth/sign-in/social`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({
      provider: 'platform', callbackURL: `${BASE}/`,
      ...(mode === 'id-token' ? { idToken: { token: await oidc.idToken() } } : {}),
    }),
  }))
}

function callbackRequest(method: 'GET' | 'POST', callback: URL, cookie: string) {
  return method === 'GET'
    ? new Request(callback, { headers: { cookie } })
    : new Request(`${BASE}${callback.pathname}`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: callback.searchParams,
      })
}

async function followFormRedirect(response: Response, method: 'GET' | 'POST', cookie: string) {
  if (method === 'GET') return response
  expect(response.status).toBe(302)
  const location = response.headers.get('location')!
  return handleAuthRequest(new Request(location, { headers: { cookie } }))
}

async function assertRejected(response: Response, code: 'OIDC_ISSUER_MISMATCH' | 'OIDC_ISSUER_MISSING') {
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code })
  expect(responseCookies(response)).not.toContain('session_token=')
  expect(oidc.state.tokenExchanges).toHaveLength(0)
  expect(await testDb.select().from(user)).toHaveLength(0)
  expect(await testDb.select().from(authAccount)).toHaveLength(0)
  expect(await testDb.select().from(authSession)).toHaveLength(0)
}

beforeEach(async () => {
  oidc = await createOidcTestServer()
  oidc.state.acceptedRedirectUri = `${BASE}/api/auth/oauth2/callback/platform`
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('BETTER_AUTH_SECRET', 'issuer-test-secret-0123456789abcdef0123456789abcdef')
  vi.stubEnv('TRUSTED_ORIGINS', BASE)
  vi.stubEnv('PLATFORM_TOKEN', '')
  configureProvider(oidc.state.issuer)
  database = await createTestDatabase()
  testDb = database.db
  resetAuth()
})

afterEach(async () => {
  resetAuth()
  await database?.close()
  await oidc?.close()
  vi.unstubAllEnvs()
  expect(oidc.state.failures).toEqual([])
})

describe('configured issuer pin', () => {
  it('ignores a disabled old provider when the same ID has an enabled replacement', async () => {
    vi.stubEnv('AUTH_PROVIDERS_JSON', JSON.stringify([
      { id: 'platform', type: 'oidc', enabled: false, issuer: WRONG_ISSUER, clientId: 'old-client' },
      { id: 'platform', type: 'oidc', issuer: oidc.state.issuer, clientId: 'test-client' },
    ]))
    const { callback, cookie } = await beginOidcLogin(handleAuthRequest, BASE)
    const response = await handleAuthRequest(new Request(callback, { headers: { cookie } }))
    expect(response.headers.get('location')).toBe(`${BASE}/`)
    expect(await testDb.select().from(authSession)).toHaveLength(1)
  })

  it.each(['redirect', 'id-token'] as const)('rejects a discovery mismatch before %s sign-in', async (mode) => {
    configureProvider(WRONG_ISSUER)
    await assertRejected(await signIn(mode), 'OIDC_ISSUER_MISMATCH')
    expect(oidc.state.authorizations).toHaveLength(0)
    expect(oidc.state.jwksRequests).toBe(0)
  })

  it.each(['redirect', 'id-token'] as const)('checks discovery recovered on the same %s request', async (mode) => {
    configureProvider(WRONG_ISSUER)
    oidc.state.discoveryUnavailable = true
    const context = await getAuth().$context
    expect(context.socialProviders).toHaveLength(0)
    oidc.state.discoveryUnavailable = false
    await assertRejected(await signIn(mode), 'OIDC_ISSUER_MISMATCH')
    expect(oidc.state.discoveryRequests).toBe(2)
    expect(context.socialProviders.map(provider => provider.id)).toContain('platform')
  })

  it('also enforces the pin on server-side SSO initiation', async () => {
    configureProvider(WRONG_ISSUER)
    await expect(getAuth().api.signInSocial({
      body: { provider: 'platform', callbackURL: `${BASE}/` },
    })).rejects.toMatchObject({ body: { code: 'OIDC_ISSUER_MISMATCH' } })
  })

  it.each(['GET', 'POST'] as const)('rejects a pin changed before an in-flight %s callback', async (method) => {
    const { callback, cookie } = await beginOidcLogin(handleAuthRequest, BASE)
    configureProvider(WRONG_ISSUER)
    resetAuth()
    await assertRejected(await handleAuthRequest(callbackRequest(method, callback, cookie)), 'OIDC_ISSUER_MISMATCH')
  })
})

describe.each(['explicit', 'discovered'] as const)('%s issuer on callbacks', (issuerSource) => {
  beforeEach(() => {
    configureProvider(issuerSource === 'explicit' ? oidc.state.issuer : undefined)
  })

  it.each(['GET', 'POST'] as const)('accepts matching %s callbacks', async (method) => {
    const { callback, cookie } = await beginOidcLogin(handleAuthRequest, BASE)
    const first = await handleAuthRequest(callbackRequest(method, callback, cookie))
    const response = await followFormRedirect(first, method, cookie)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${BASE}/`)
    expect(responseCookies(response)).toContain('session_token=')
    expect(await testDb.select().from(authSession)).toHaveLength(1)
  })

  it.each(['GET', 'POST'] as const)('rejects missing iss in a %s callback before code exchange', async (method) => {
    const { callback, cookie } = await beginOidcLogin(handleAuthRequest, BASE)
    callback.searchParams.delete('iss')
    await assertRejected(await handleAuthRequest(callbackRequest(method, callback, cookie)), 'OIDC_ISSUER_MISSING')
  })

  it.each(['GET', 'POST'] as const)('rejects the wrong iss in a %s callback before code exchange', async (method) => {
    const { callback, cookie } = await beginOidcLogin(handleAuthRequest, BASE)
    callback.searchParams.set('iss', WRONG_ISSUER)
    await assertRejected(await handleAuthRequest(callbackRequest(method, callback, cookie)), 'OIDC_ISSUER_MISMATCH')
  })
})

describe('callback routing boundaries', () => {
  it.each(['GET', 'POST'] as const)('also rejects missing iss on the direct core %s route', async (method) => {
    const { callback, cookie } = await beginOidcLogin(handleAuthRequest, BASE)
    callback.pathname = '/api/auth/callback/platform'
    callback.searchParams.delete('iss')
    await assertRejected(await handleAuthRequest(callbackRequest(method, callback, cookie)), 'OIDC_ISSUER_MISSING')
  })

  it('uses the same query-over-form precedence as the core callback', async () => {
    const { callback, cookie } = await beginOidcLogin(handleAuthRequest, BASE)
    const response = await handleAuthRequest(new Request(`${BASE}${callback.pathname}?iss=${encodeURIComponent(WRONG_ISSUER)}`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: callback.searchParams,
    }))
    await assertRejected(response, 'OIDC_ISSUER_MISMATCH')
  })

  it.each(['GET', 'POST'] as const)('preserves provider error redirects without iss for %s callbacks', async (method) => {
    const { callback, cookie } = await beginOidcLogin(handleAuthRequest, BASE)
    callback.searchParams.delete('iss')
    callback.searchParams.set('error', 'access_denied')
    // Even an IdP sending both code and error must keep the normal error path.
    configureProvider(WRONG_ISSUER)
    const first = await handleAuthRequest(callbackRequest(method, callback, cookie))
    const response = await followFormRedirect(first, method, cookie)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${BASE}/login-error?error=access_denied`)
    expect(oidc.state.tokenExchanges).toHaveLength(0)
    expect(await testDb.select().from(authSession)).toHaveLength(0)
  })
})
