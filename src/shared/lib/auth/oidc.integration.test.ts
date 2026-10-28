/** Real HTTP OIDC discovery, code/PKCE exchange and signed JWKS verification. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { auditLog, authAccount, authSession, user } from '../db/schema'
import {
  beginOidcLogin, completeOidcLogin, createOidcTestServer, responseCookies, type OidcTestServer,
} from './testing/oidc-server'

let handle: TestDatabase
let testDb: AppDatabase
let oidc: OidcTestServer
const authSettings = vi.hoisted(() => ({ requireAdminApproval: false, maxConcurrentSessions: 12 }))
const captureExceptionMock = vi.hoisted(() => vi.fn())

vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/error-reporting', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/error-reporting')>(),
  captureException: captureExceptionMock,
}))
vi.mock('@shared/lib/config/settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/config/settings')>(),
  getSettings: () => ({ auth: authSettings }),
}))

import { getAuth, resetAuth } from './index'
import { handleAuthRequest } from './handler'

const BASE = 'http://localhost:47891'
const ORG = 'org_oidc_test'
const ORG_CLAIM = 'https://platform.skillfulagents.dev/claims/org_id'
const ROLE_CLAIM = 'https://platform.skillfulagents.dev/claims/role'

function request(endpoint: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  return handleAuthRequest(new Request(`${BASE}/api/auth/${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', origin: BASE, ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }))
}

beforeEach(async () => {
  captureExceptionMock.mockReset()
  authSettings.requireAdminApproval = false
  authSettings.maxConcurrentSessions = 12
  oidc = await createOidcTestServer()
  oidc.state.acceptedRedirectUri = `${BASE}/api/auth/oauth2/callback/platform`
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('BETTER_AUTH_SECRET', 'oidc-test-secret-0123456789abcdef0123456789abcdef')
  vi.stubEnv('TRUSTED_ORIGINS', BASE)
  vi.stubEnv('AUTH_PROVIDERS_JSON', JSON.stringify([{
    id: 'platform', type: 'oidc', issuer: oidc.state.issuer, clientId: 'test-client',
    scopes: ['openid', 'profile', 'email'],
  }]))
  vi.stubEnv('PLATFORM_TOKEN', `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ orgId: ORG })).toString('base64url')}.sig`)
  handle = await createTestDatabase()
  testDb = handle.db
  resetAuth()
})

afterEach(async () => {
  resetAuth()
  await handle?.close()
  await oidc?.close()
  vi.unstubAllEnvs()
  expect(oidc.state.failures).toEqual([])
})

async function assertNoIdentity() {
  expect(await testDb.select().from(user)).toHaveLength(0)
  expect(await testDb.select().from(authAccount)).toHaveLength(0)
  expect(await testDb.select().from(authSession)).toHaveLength(0)
}

async function assertRejected(response: Response) {
  expect(response.headers.get('location')).not.toBe(`${BASE}/`)
  expect(responseCookies(response)).not.toContain('session_token=')
  await assertNoIdentity()
}

describe('OIDC callback compatibility', () => {
  it.each(['GET', 'POST'] as const)('completes the registered legacy %s callback with verified identity, PKCE, cookies and one audit row', async (method) => {
    const { callback, cookie } = await beginOidcLogin(handleAuthRequest, BASE)
    expect(callback.pathname).toBe('/api/auth/oauth2/callback/platform')
    let finish = await handleAuthRequest(method === 'GET'
      ? new Request(callback, { headers: { cookie } })
      : new Request(`${BASE}${callback.pathname}`, {
          method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
          body: callback.searchParams,
        }))
    if (method === 'POST') {
      expect(finish.status).toBe(302)
      const next = new URL(finish.headers.get('location')!)
      expect(next.pathname).toBe('/api/auth/callback/platform')
      finish = await handleAuthRequest(new Request(next, { headers: { cookie } }))
    }
    expect(finish.status).toBe(302)
    expect(finish.headers.get('location')).toBe(`${BASE}/`)
    const sessionCookie = responseCookies(finish)
    expect(sessionCookie).toContain('session_token=')
    const session = await request('get-session', undefined, { cookie: sessionCookie })
    expect(await session.json()).toMatchObject({ user: { email: 'ada@example.com' } })
    const accounts = await testDb.select().from(authAccount)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ providerId: 'platform', accountId: 'sub_member_one' })
    const sessions = await testDb.select().from(authSession)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].creationMethod).toBe('oidc')
    const audit = await testDb.select().from(auditLog).where(eq(auditLog.object, 'session'))
    expect(audit).toHaveLength(1)
    expect(audit[0].details).toBe(JSON.stringify({ method: 'oidc' }))
    expect(oidc.state.tokenExchanges).toHaveLength(1)
    expect(oidc.state.jwksRequests).toBe(1)

    // State and code cannot mint another session when the callback is replayed.
    const replay = await handleAuthRequest(new Request(callback, { headers: { cookie } }))
    expect(replay.headers.get('location')).not.toBe(`${BASE}/`)
    expect(await testDb.select().from(authSession)).toHaveLength(1)
    expect(oidc.state.tokenExchanges).toHaveLength(1)
  })

  it('links the existing unverified password account and keeps subject identity stable across email changes', async () => {
    const local = await getAuth().api.signUpEmail({
      body: { name: 'Local Name', email: 'ada@example.com', password: 'ExistingPassword123!' },
    })
    expect(local.user.emailVerified).toBe(false)
    const first = await completeOidcLogin(handleAuthRequest, BASE)
    expect(first.headers.get('location')).toBe(`${BASE}/`)
    const linked = await testDb.select().from(authAccount)
    expect(linked).toHaveLength(2)
    expect(linked.find(account => account.providerId === 'platform')?.userId).toBe(local.user.id)

    const override = '/api/profile/images/00000000-0000-4000-8000-000000000001.png'
    await testDb.update(user).set({ avatarOverride: override }).where(eq(user.id, local.user.id))
    oidc.state.profile.email = 'renamed@example.com'
    oidc.state.profile.picture = 'https://example.com/new.png'
    const second = await completeOidcLogin(handleAuthRequest, BASE)
    expect(second.headers.get('location')).toBe(`${BASE}/`)
    expect(await testDb.select().from(user)).toEqual([expect.objectContaining({
      id: local.user.id, image: 'https://example.com/new.png', avatarOverride: override,
    })])
    expect(await testDb.select().from(authAccount)).toHaveLength(2)
    const session = await request('get-session', undefined, { cookie: responseCookies(second) })
    expect(await session.json()).toMatchObject({ user: { id: local.user.id } })
  })

  it('signs out only the deployment session and does not redirect to the provider logout endpoint', async () => {
    const finish = await completeOidcLogin(handleAuthRequest, BASE)
    const cookie = responseCookies(finish)
    const logout = await request('sign-out', {}, { cookie })
    expect(logout.status).toBe(200)
    expect(await logout.json()).toEqual({ success: true })
    expect(logout.headers.get('location')).toBeNull()
    expect(await (await request('get-session', undefined, { cookie })).json()).toBeNull()
    expect(await testDb.select().from(authSession)).toHaveLength(0)
  })
})

describe('OIDC rejection boundaries', () => {
  it.each([
    ['wrong issuer', { iss: 'https://other-issuer.example.com' }],
    ['wrong audience', { aud: 'another-client' }],
    ['expired token', { exp: 1 }],
    ['missing expiry', { exp: undefined }],
    ['missing issued-at', { iat: undefined }],
    ['wrong nonce', { nonce: 'wrong-nonce' }],
    ['wrong organization', { [ORG_CLAIM]: 'org_other' }],
    ['unverified email', { email_verified: false }],
  ])('rejects %s without provisioning an identity', async (_label, claims) => {
    oidc.state.claims = claims
    await assertRejected(await completeOidcLogin(handleAuthRequest, BASE))
  })

  it('rejects a token signed by an unpublished key', async () => {
    oidc.state.wrongSigningKey = true
    await assertRejected(await completeOidcLogin(handleAuthRequest, BASE))
  })

  it('rejects a token that omits the request nonce', async () => {
    oidc.state.omitNonce = true
    await assertRejected(await completeOidcLogin(handleAuthRequest, BASE))
  })

  it('rejects a missing subject instead of using another profile id', async () => {
    oidc.state.claims = { sub: '', id: 'must-not-be-used' }
    oidc.state.profile.sub = ''
    oidc.state.profile.id = 'must-not-be-used'
    await assertRejected(await completeOidcLogin(handleAuthRequest, BASE))
  })

  it.each(['wrong state', 'no cookie', 'wrong callback issuer'])('rejects %s before code exchange', async (failure) => {
    const { callback, cookie } = await beginOidcLogin(handleAuthRequest, BASE)
    if (failure === 'wrong state') callback.searchParams.set('state', 'forged-state')
    if (failure === 'wrong callback issuer') callback.searchParams.set('iss', 'https://wrong.example.com')
    await assertRejected(await handleAuthRequest(new Request(callback, {
      headers: failure === 'no cookie' ? {} : { cookie },
    })))
    expect(oidc.state.tokenExchanges).toHaveLength(0)
  })

  it('fails closed when discovery omits the verification keys', async () => {
    oidc.state.omitJwks = true
    const start = await request('sign-in/social', { provider: 'platform', callbackURL: `${BASE}/` })
    expect(start.status).toBe(404)
    await assertNoIdentity()
    expect(oidc.state.authorizations).toHaveLength(0)
  })

  it('recovers after failed first-use discovery without restarting the app', async () => {
    oidc.state.discoveryUnavailable = true
    await getAuth().$context
    expect(oidc.state.discoveryRequests).toBe(0)
    const failed = await request('sign-in/social', { provider: 'platform', callbackURL: `${BASE}/` })
    expect(failed.status).toBe(404)
    expect(oidc.state.discoveryRequests).toBe(1)
    await assertNoIdentity()
    oidc.state.discoveryUnavailable = false
    const finish = await completeOidcLogin(handleAuthRequest, BASE)
    expect(finish.headers.get('location')).toBe(`${BASE}/`)
    expect(await testDb.select().from(authSession)).toHaveLength(1)
    expect(oidc.state.discoveryRequests).toBe(2)
  })
})

describe('direct provider ID-token sign-in', () => {
  it.each([
    ['wrong issuer', { iss: 'https://other.example.com' }],
    ['wrong audience', { aud: 'another-client' }],
    ['expired token', { exp: 1 }],
    ['wrong organization', { [ORG_CLAIM]: 'org_other' }],
    ['unverified email', { email_verified: false }],
  ])('applies the same %s rejection without creating an account', async (_label, claims) => {
    oidc.state.claims = claims
    const response = await request('sign-in/social', {
      provider: 'platform', idToken: { token: await oidc.idToken() },
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    await assertNoIdentity()
  })

  it('accepts a verified token under the configured client and preserves the member subject', async () => {
    const response = await request('sign-in/social', {
      provider: 'platform', idToken: { token: await oidc.idToken() },
    })
    expect(response.status).toBe(200)
    expect(await testDb.select().from(authAccount)).toEqual([
      expect.objectContaining({ providerId: 'platform', accountId: 'sub_member_one' }),
    ])
    expect(await testDb.select().from(authSession)).toHaveLength(1)
    const [session] = await testDb.select().from(authSession)
    expect(session.creationMethod).toBe('oidc')
    const audit = await testDb.select().from(auditLog).where(eq(auditLog.object, 'session'))
    expect(audit).toHaveLength(1)
    expect(audit[0].details).toBe(JSON.stringify({ method: 'oidc' }))
  })

  it('does not issue another session for a banned account', async () => {
    const first = await request('sign-in/social', {
      provider: 'platform', idToken: { token: await oidc.idToken() },
    })
    expect(first.status).toBe(200)
    const [existing] = await testDb.select().from(user)
    await testDb.update(user).set({ banned: true, banReason: 'Test ban' }).where(eq(user.id, existing.id))
    const denied = await request('sign-in/social', {
      provider: 'platform', idToken: { token: await oidc.idToken() },
    })
    expect(denied.status).toBeGreaterThanOrEqual(400)
    expect(await testDb.select().from(authSession)).toHaveLength(1)
  })

  it('does not issue a session while a newly provisioned account awaits admin approval', async () => {
    // Approval is disabled on platform-controlled deployments. Use a plain
    // auth deployment to exercise the admin approval hook itself.
    vi.stubEnv('PLATFORM_TOKEN', '')
    await getAuth().api.signUpEmail({
      body: { name: 'First Admin', email: 'admin@example.com', password: 'FirstAdminPassword123!' },
    })
    authSettings.requireAdminApproval = true
    resetAuth()
    const denied = await request('sign-in/social', {
      provider: 'platform', idToken: { token: await oidc.idToken() },
    })
    expect(denied.status).toBeGreaterThanOrEqual(400)
    const [pending] = await testDb.select().from(user).where(eq(user.email, 'ada@example.com'))
    expect(pending.banned).toBe(true)
    expect(await testDb.select().from(authSession).where(eq(authSession.userId, pending.id))).toHaveLength(0)
  })

  it('enforces the interactive session cap for direct ID-token logins', async () => {
    authSettings.maxConcurrentSessions = 2
    for (let i = 0; i < 3; i++) {
      const response = await request('sign-in/social', {
        provider: 'platform', idToken: { token: await oidc.idToken() },
      })
      expect(response.status).toBe(200)
    }
    const sessions = await testDb.select().from(authSession)
    expect(sessions).toHaveLength(2)
    expect(sessions.every(session => session.creationMethod === 'oidc')).toBe(true)
    expect(await testDb.select().from(auditLog).where(eq(auditLog.object, 'session'))).toHaveLength(3)
  })
})

describe('platform role on join', () => {
  async function roleOf(email: string) {
    const [row] = await testDb.select({ role: user.role }).from(user).where(eq(user.email, email))
    return row?.role
  }
  async function signIn(role?: string) {
    if (role === undefined) delete oidc.state.profile[ROLE_CLAIM]
    else oidc.state.profile[ROLE_CLAIM] = role
    const finish = await completeOidcLogin(handleAuthRequest, BASE)
    expect(finish.headers.get('location')).toBe(`${BASE}/`)
    return responseCookies(finish)
  }
  async function seedOtherMember() {
    await getAuth().api.signUpEmail({
      body: { name: 'Earlier Member', email: 'earlier@example.com', password: 'EarlierPassword123!' },
    })
  }

  it('promotes nobody for arriving first outside a Platform sign-in', async () => {
    await getAuth().api.signUpEmail({
      body: { name: 'Earliest', email: 'earliest@example.com', password: 'EarliestPassword123!' },
    })
    expect(await roleOf('earliest@example.com')).toBe('user')
  })

  it('gives a member who arrives first the user role rather than the first-user admin', async () => {
    await signIn('member')
    expect(await roleOf('ada@example.com')).toBe('user')
  })

  it.each(['owner', 'admin'])('makes a Platform %s who joins later an admin', async (role) => {
    await seedOtherMember()
    const cookie = await signIn(role)
    expect(await roleOf('ada@example.com')).toBe('admin')
    // The sign-in's own session already sees it.
    expect(await (await request('get-session', undefined, { cookie })).json()).toMatchObject({ user: { role: 'admin' } })
  })

  it.each([
    ['a promotion', 'member', 'admin'],
    ['a demotion', 'owner', 'user'],
  ])('keeps %s made in Gamut on later sign-ins', async (_label, platformRole, localRole) => {
    await seedOtherMember()
    await signIn(platformRole)
    await testDb.update(user).set({ role: localRole }).where(eq(user.email, 'ada@example.com'))
    await signIn(platformRole)
    expect(await roleOf('ada@example.com')).toBe(localRole)
  })

  it('keeps the role of an existing password user who links Platform', async () => {
    await seedOtherMember()
    await getAuth().api.signUpEmail({
      body: { name: 'Ada Lovelace', email: 'ada@example.com', password: 'ExistingPassword123!' },
    })
    await signIn('owner')
    expect(await testDb.select().from(authAccount).where(eq(authAccount.providerId, 'platform'))).toHaveLength(1)
    expect(await roleOf('ada@example.com')).toBe('user')
  })

  it('keeps the role of a re-invited member whose new membership links to their user', async () => {
    await seedOtherMember()
    await signIn('member')
    await testDb.update(user).set({ role: 'admin' }).where(eq(user.email, 'ada@example.com'))
    oidc.state.profile.sub = 'sub_member_two'
    await signIn('member')
    expect(await testDb.select().from(authAccount).where(eq(authAccount.providerId, 'platform'))).toHaveLength(2)
    expect(await roleOf('ada@example.com')).toBe('admin')
  })

  it('keeps the role of an existing user with no account who links Platform', async () => {
    const now = new Date()
    await testDb.insert(user).values({
      id: 'user-without-account', name: 'Ada Lovelace', email: 'ada@example.com', emailVerified: true,
      role: 'admin', createdAt: now, updatedAt: now,
    })
    await signIn('member')
    expect(await testDb.select().from(authAccount)).toEqual([expect.objectContaining({ userId: 'user-without-account' })])
    expect(await roleOf('ada@example.com')).toBe('admin')
  })

  it('does not report a missing role when linking an existing user', async () => {
    await getAuth().api.signUpEmail({
      body: { name: 'Ada Lovelace', email: 'ada@example.com', password: 'ExistingPassword123!' },
    })
    await signIn(undefined)
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })

  it('applies the role from a direct ID-token sign-in too', async () => {
    await seedOtherMember()
    oidc.state.profile[ROLE_CLAIM] = 'admin'
    const response = await request('sign-in/social', {
      provider: 'platform', idToken: { token: await oidc.idToken() },
    })
    expect(response.status).toBe(200)
    expect(await roleOf('ada@example.com')).toBe('admin')
  })

  it.each([
    ['a missing', undefined],
    ['an unrecognized', 'superuser'],
  ])('reports %s role and falls back to the first-user bootstrap', async (_label, role) => {
    await signIn(role)
    expect(await roleOf('ada@example.com')).toBe('admin')
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Unrecognized platform role' }),
      expect.objectContaining({ tags: { area: 'auth', op: 'platform-role' } }),
    )
  })

  it('gives a later member with no role the default role', async () => {
    await seedOtherMember()
    await signIn(undefined)
    expect(await roleOf('ada@example.com')).toBe('user')
  })

  it('ignores the role claim on a deployment that is not platform-controlled', async () => {
    vi.stubEnv('PLATFORM_TOKEN', '')
    resetAuth()
    await seedOtherMember()
    await signIn('owner')
    expect(await roleOf('ada@example.com')).toBe('user')
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })
})
