/**
 * Claiming an invited user (team directories) through the real Better Auth:
 * a Platform OIDC sign-in links to the invited row and gets its role, a plain
 * sign-up with its email sets a password on it, and either way the access and
 * the notification made for them before they joined are theirs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { agentAcl, authAccount, notifications, user } from '../db/schema'
import { completeOidcLogin, createOidcTestServer, responseCookies, type OidcTestServer } from './testing/oidc-server'

let handle: TestDatabase
let testDb: AppDatabase
let oidc: OidcTestServer
const authSettings = vi.hoisted(() => ({
  requireAdminApproval: false, maxConcurrentSessions: 12, allowLocalAuth: true, passwordMinLength: 8, passwordMaxLength: 128,
  passwordRequireComplexity: false, signupMode: 'invitation_only' as 'invitation_only' | 'closed' | 'open',
}))

vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/config/settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/config/settings')>(),
  getSettings: () => ({ auth: authSettings, teamBrain: { agentSlug: 'team-brain' } }),
  getTeamBrain: async () => ({ agentSlug: 'team-brain' }),
}))

import { resetAuth } from './index'
import { handleAuthRequest } from './handler'
import { authEnforcementMiddleware } from '../../../api/middleware/auth-enforcement'

const BASE = 'http://localhost:47892'
const ORG = 'org_invited_test'
const ROLE_CLAIM = 'https://platform.skillfulagents.dev/claims/role'
const INVITED_ID = 'invited-ada'
// The sign-up route as the app mounts it: enforcement, then Better Auth.
const app = new Hono()
app.use('/api/auth/*', authEnforcementMiddleware)
app.on(['POST', 'GET'], '/api/auth/*', (c) => handleAuthRequest(c.req.raw))

function auth(endpoint: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  return handleAuthRequest(new Request(`${BASE}/api/auth/${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', origin: BASE, ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }))
}

const signUp = (body: Record<string, unknown>) => app.request(`${BASE}/api/auth/sign-up/email`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(body),
})

async function seed() {
  const now = new Date()
  await testDb.insert(user).values([
    { id: 'inviter', name: 'Grace Inviter', email: 'grace@example.com', emailVerified: true, role: 'admin', createdAt: now, updatedAt: now },
    {
      id: INVITED_ID, name: 'Ada (from Slack)', email: 'ada@example.com', emailVerified: false, role: 'user',
      status: 'invited', invitedByUserId: 'inviter', directoryProvider: 'slack', directoryTenantId: 'T1', directoryRemoteId: 'U1',
      createdAt: now, updatedAt: now,
    },
  ]).run()
  // Shared with, and mentioned, before joining.
  await testDb.insert(agentAcl).values({ id: 'acl-support', userId: INVITED_ID, agentSlug: 'support', role: 'user', createdAt: now }).run()
  await testDb.insert(notifications).values({
    id: 'mention-1', type: 'session_mention', sessionId: 's1', agentSlug: 'support', title: 'Grace mentioned you', body: 'look at this',
    recipientUserId: INVITED_ID, messageUuid: 'm1', createdAt: now,
  }).run()
}

async function invitedRow() {
  return testDb.select().from(user).where(eq(user.id, INVITED_ID)).get()
}

async function agentsOf(userId: string) {
  return (await testDb.select({ agentSlug: agentAcl.agentSlug }).from(agentAcl).where(eq(agentAcl.userId, userId)).all()).map((row) => row.agentSlug).sort()
}

beforeEach(async () => {
  authSettings.requireAdminApproval = false
  authSettings.allowLocalAuth = true
  authSettings.signupMode = 'invitation_only'
  oidc = await createOidcTestServer()
  oidc.state.acceptedRedirectUri = `${BASE}/api/auth/oauth2/callback/platform`
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('BETTER_AUTH_SECRET', 'invited-test-secret-0123456789abcdef0123456789abcdef')
  vi.stubEnv('TRUSTED_ORIGINS', BASE)
  vi.stubEnv('AUTH_PROVIDERS_JSON', JSON.stringify([{
    id: 'platform', type: 'oidc', issuer: oidc.state.issuer, clientId: 'test-client', scopes: ['openid', 'profile', 'email'],
  }]))
  handle = await createTestDatabase()
  testDb = handle.db
  resetAuth()
  await seed()
})

afterEach(async () => {
  resetAuth()
  await handle?.close()
  await oidc?.close()
  vi.unstubAllEnvs()
})

describe('an invited user before they join', () => {
  it('cannot sign in as the row: it has no account', async () => {
    const res = await auth('sign-in/email', { email: 'ada@example.com', password: 'Anything123!' })
    expect(res.status).toBe(401)
    expect((await invitedRow())?.status).toBe('invited')
  })
})

describe('claiming through a Platform sign-in (platform-controlled)', () => {
  beforeEach(() => {
    vi.stubEnv('PLATFORM_TOKEN', `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ orgId: ORG })).toString('base64url')}.sig`)
    oidc.state.claims = { 'https://platform.skillfulagents.dev/claims/org_id': ORG }
    resetAuth()
  })

  it.each([
    ['owner', 'admin'],
    ['member', 'user'],
  ])('links the login to the invited row, which joins with the Platform %s role as %s', async (platformRole, role) => {
    oidc.state.profile[ROLE_CLAIM] = platformRole
    const finish = await completeOidcLogin(handleAuthRequest, BASE)
    expect(finish.headers.get('location')).toBe(`${BASE}/`)

    // One user for the email: the invited row, now theirs.
    const rows = await testDb.select().from(user).where(eq(user.email, 'ada@example.com')).all()
    expect(rows.map((row) => row.id)).toEqual([INVITED_ID])
    expect(rows[0]).toMatchObject({ status: 'active', role, emailVerified: true, banned: false })
    expect(await testDb.select({ userId: authAccount.userId, providerId: authAccount.providerId }).from(authAccount).all())
      .toEqual([{ userId: INVITED_ID, providerId: 'platform' }])

    // What was waiting for them is there, and they get what every member gets.
    expect(await agentsOf(INVITED_ID)).toEqual(['support', 'team-brain'])
    expect((await testDb.select().from(notifications).where(eq(notifications.recipientUserId, INVITED_ID)).all()).map((n) => n.id)).toEqual(['mention-1'])
    const session = await auth('get-session', undefined, { cookie: responseCookies(finish) })
    expect(await session.json()).toMatchObject({ user: { id: INVITED_ID, role } })
  })

  it('takes no password sign-up there: members come from Platform', async () => {
    const res = await signUp({ name: 'Ada', email: 'ada@example.com', password: 'Password123!' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'SIGNUPS_DISABLED' })
    expect((await invitedRow())?.status).toBe('invited')
  })
})

describe('claiming through single sign-on with admin approval on', () => {
  it('joins pending approval, as a new member would', async () => {
    authSettings.requireAdminApproval = true
    const finish = await completeOidcLogin(handleAuthRequest, BASE)
    expect(finish.headers.get('location')).not.toBe(`${BASE}/`)
    expect(await invitedRow()).toMatchObject({ status: 'active', banned: true, banReason: 'Pending admin approval' })
  })
})

describe('claiming by signing up with their email', () => {
  it('signs them up into the account waiting for them, while sign-ups are otherwise invitation-only', async () => {
    const stranger = await signUp({ name: 'Mallory', email: 'mallory@example.com', password: 'Password123!' })
    expect(stranger.status).toBe(403)

    const joined = await signUp({ name: 'Ada Lovelace', email: 'ADA@example.com', password: 'Password123!' })
    expect(joined.status).toBe(200)
    expect(await joined.json()).toMatchObject({ user: { id: INVITED_ID } })
    // Joined, as anyone who signs up with a password: the address isn't verified.
    expect(await invitedRow()).toMatchObject({ status: 'active', name: 'Ada Lovelace', emailVerified: false, banned: false })
    expect(await agentsOf(INVITED_ID)).toEqual(['support', 'team-brain'])
    expect((await testDb.select().from(notifications).where(eq(notifications.recipientUserId, INVITED_ID)).all()).map((n) => n.id)).toEqual(['mention-1'])
    const session = await auth('get-session', undefined, { cookie: responseCookies(joined) })
    expect(await session.json()).toMatchObject({ user: { id: INVITED_ID } })

    // One account: signing up again is an ordinary sign-up, which invitation-only refuses.
    expect((await signUp({ name: 'Ada', email: 'ada@example.com', password: 'Password456!' })).status).toBe(403)
    expect((await auth('sign-in/email', { email: 'ada@example.com', password: 'Password123!' })).status).toBe(200)
  })

  it('joins pending approval when an admin must approve', async () => {
    authSettings.requireAdminApproval = true
    expect((await signUp({ name: 'Ada', email: 'ada@example.com', password: 'Password123!' })).status).toBe(403)
    expect(await invitedRow()).toMatchObject({ status: 'active', banned: true, banReason: 'Pending admin approval' })
    expect((await auth('sign-in/email', { email: 'ada@example.com', password: 'Password123!' })).status).toBe(403)
  })

  it('refuses a short password, and any sign-up while sign-ups are closed, changing nothing', async () => {
    expect((await signUp({ name: 'Ada', email: 'ada@example.com', password: 'short' })).status).toBe(400)
    authSettings.signupMode = 'closed'
    expect((await signUp({ name: 'Ada', email: 'ada@example.com', password: 'Password123!' })).status).toBe(403)
    expect((await invitedRow())?.status).toBe('invited')
    expect(await testDb.select().from(authAccount).all()).toEqual([])
  })

  it('gives the password to one of two sign-ups at once', async () => {
    const results = await Promise.all([
      signUp({ name: 'Ada', email: 'ada@example.com', password: 'Password123!' }),
      signUp({ name: 'Ada', email: 'ada@example.com', password: 'Password456!' }),
    ])
    // The other finds the account taken: by the claim, or already joined.
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((status) => status === 200)).toHaveLength(1)
    expect(statuses.filter((status) => status !== 200)).toEqual([expect.toBeOneOf([403, 422])])
    expect(await testDb.select().from(authAccount).where(eq(authAccount.userId, INVITED_ID)).all()).toHaveLength(1)
  })
})

describe('the Users tab', () => {
  it('lists members and invited people apart, counting only members', async () => {
    const signUp = await auth('sign-up/email', { name: 'Admin', email: 'admin@example.com', password: 'AdminPassword123!' })
    expect(signUp.status).toBe(200)
    await testDb.update(user).set({ role: 'admin' }).where(eq(user.email, 'admin@example.com')).run()
    const signIn = await auth('sign-in/email', { email: 'admin@example.com', password: 'AdminPassword123!' })
    const cookie = responseCookies(signIn)
    const list = async (status: string) => (await auth(`admin/list-users?filterField=status&filterValue=${status}&filterOperator=eq&sortBy=email`, undefined, { cookie })).json() as Promise<{ users: Array<{ email: string }>; total: number }>

    const members = await list('active')
    expect(members.users.map((u) => u.email)).toEqual(['admin@example.com', 'grace@example.com'])
    expect(members.total).toBe(2)
    const invited = await list('invited')
    expect(invited.users.map((u) => u.email)).toEqual(['ada@example.com'])
  })
})
