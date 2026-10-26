/**
 * Exercise the real Better Auth HTTP endpoints, adapter and application hooks.
 * The database fixture runs on both SQLite and libsql. Only the two failure
 * cases inject an adapter error; password hashing and HTTP/cookie handling
 * stay real throughout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { authAccount, authSession, user } from '../db/schema'

let handle: TestDatabase
let testDb: AppDatabase

vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/config/settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/config/settings')>(),
  getSettings: () => ({
    auth: {
      requireAdminApproval: false,
      maxConcurrentSessions: 12,
      sessionMaxLifetimeHrs: 2,
      sessionIdleTimeoutMin: 60,
    },
  }),
}))

import { getAuth, resetAuth } from './index'

const BASE = 'http://localhost:47891'
const PASSWORD = 'OriginalPassword123!'
const NEW_PASSWORD = 'ReplacementPassword456!'
const LIFETIME_MS = 2 * 60 * 60 * 1000

const credentialsSchema = z.object({
  token: z.string().min(1),
  user: z.object({ id: z.string(), email: z.string() }),
})
const sessionSchema = z.object({
  session: z.object({ id: z.string(), token: z.string(), expiresAt: z.coerce.date() }),
  user: z.object({ id: z.string(), mustChangePassword: z.boolean() }),
}).nullable()

function request(endpoint: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  return getAuth().handler(new Request(`${BASE}/api/auth/${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: { origin: BASE, 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }))
}

function cookiesOf(response: Response): string {
  return response.headers.getSetCookie()
    .filter(value => !/max-age=0(?:;|$)/i.test(value))
    .map(value => value.split(';')[0])
    .join('; ')
}

async function signUp(email = 'password-session@example.com') {
  const response = await request('sign-up/email', { email, password: PASSWORD, name: 'Session Test' })
  expect(response.status).toBe(200)
  return { ...credentialsSchema.parse(await response.json()), cookie: cookiesOf(response) }
}

async function signIn(email: string, password = PASSWORD) {
  const response = await request('sign-in/email', { email, password })
  expect(response.status).toBe(200)
  return { ...credentialsSchema.parse(await response.json()), cookie: cookiesOf(response) }
}

async function sessionFor(headers: Record<string, string>) {
  const response = await request('get-session', undefined, headers)
  expect(response.status).toBe(200)
  return sessionSchema.parse(await response.json())
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

async function requirePasswordChange(userId: string) {
  await testDb.update(user).set({ mustChangePassword: true }).where(eq(user.id, userId))
}

async function sessionRow(token: string) {
  return testDb.select().from(authSession).where(eq(authSession.token, token)).get()
}

beforeEach(async () => {
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('BETTER_AUTH_SECRET', 'password-session-test-secret-0123456789abcdef0123456789abcdef')
  vi.stubEnv('TRUSTED_ORIGINS', BASE)
  vi.stubEnv('AUTH_PROVIDERS_JSON', '[]')
  vi.stubEnv('PLATFORM_TOKEN', '')
  handle = await createTestDatabase()
  testDb = handle.db
  resetAuth()
})

afterEach(async () => {
  vi.restoreAllMocks()
  resetAuth()
  await handle.close()
  vi.unstubAllEnvs()
})

describe('password changes and session continuity', () => {
  it('keeps both existing sessions and their lifetime when revocation is disabled', async () => {
    const first = await signUp()
    const second = await signIn(first.user.email)
    const before = await sessionRow(first.token)
    await requirePasswordChange(first.user.id)

    const changed = await request('change-password', {
      currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: false,
    }, { cookie: first.cookie })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({ token: null })

    expect(await sessionRow(first.token)).toEqual(before)
    expect(await testDb.select().from(authSession)).toHaveLength(2)
    expect(await sessionFor({ cookie: first.cookie })).toMatchObject({
      session: { token: first.token }, user: { id: first.user.id, mustChangePassword: false },
    })
    expect(await sessionFor(bearer(second.token))).toMatchObject({
      user: { id: first.user.id, mustChangePassword: false },
    })
    expect((await request('sign-in/email', { email: first.user.email, password: PASSWORD })).status).toBe(401)
    expect((await signIn(first.user.email, NEW_PASSWORD)).user.id).toBe(first.user.id)
  })

  it('rotates the current cookie, revokes previous sessions and preserves another user when requested', async () => {
    const first = await signUp()
    const second = await signIn(first.user.email)
    const otherUser = await signUp('other-session@example.com')
    await requirePasswordChange(first.user.id)
    const started = Date.now()

    const changed = await request('change-password', {
      currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true,
    }, { cookie: first.cookie })
    expect(changed.status).toBe(200)
    const replacement = credentialsSchema.parse(await changed.json())
    expect(replacement.token).not.toBe(first.token)
    expect(replacement.token).not.toBe(second.token)
    const replacementCookie = cookiesOf(changed)
    expect(replacementCookie).toContain('session_token=')

    expect(await sessionFor({ cookie: first.cookie })).toBeNull()
    expect(await sessionFor(bearer(first.token))).toBeNull()
    expect(await sessionFor(bearer(second.token))).toBeNull()
    expect(await sessionFor({ cookie: replacementCookie })).toMatchObject({
      session: { token: replacement.token }, user: { id: first.user.id, mustChangePassword: false },
    })
    expect(await sessionFor(bearer(replacement.token))).toMatchObject({ user: { id: first.user.id } })
    expect(await sessionFor(bearer(otherUser.token))).toMatchObject({ user: { id: otherUser.user.id } })
    expect(await testDb.select().from(authSession)).toHaveLength(2)
    const row = await sessionRow(replacement.token)
    expect(row?.expiresAt.getTime()).toBeGreaterThanOrEqual(started + LIFETIME_MS - 1000)
    expect(row?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + LIFETIME_MS)

    expect((await request('sign-in/email', { email: first.user.email, password: PASSWORD })).status).toBe(401)
    expect((await signIn(first.user.email, NEW_PASSWORD)).user.id).toBe(first.user.id)
  })

  it('leaves the password, change-password gate and sessions untouched after an incorrect current password', async () => {
    const first = await signUp()
    const second = await signIn(first.user.email)
    await requirePasswordChange(first.user.id)
    const accountsBefore = await testDb.select().from(authAccount)
    const sessionsBefore = await testDb.select().from(authSession)

    const changed = await request('change-password', {
      currentPassword: 'IncorrectPassword789!', newPassword: NEW_PASSWORD, revokeOtherSessions: true,
    }, { cookie: first.cookie })
    expect(changed.status).toBe(400)
    expect(await changed.json()).toMatchObject({ code: 'INVALID_PASSWORD' })
    expect(await testDb.select().from(authAccount)).toEqual(accountsBefore)
    expect(await testDb.select().from(authSession)).toEqual(sessionsBefore)
    expect(await sessionFor({ cookie: first.cookie })).toMatchObject({ user: { mustChangePassword: true } })
    expect(await sessionFor(bearer(second.token))).toMatchObject({ user: { mustChangePassword: true } })
    expect((await request('sign-in/email', { email: first.user.email, password: NEW_PASSWORD })).status).toBe(401)
    expect((await signIn(first.user.email)).user.id).toBe(first.user.id)
  })

  it('requires a session even when the caller knows the current password', async () => {
    const signedIn = await signUp()
    const changed = await request('change-password', {
      currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true,
    })
    expect(changed.status).toBe(401)
    expect(await sessionFor(bearer(signedIn.token))).toMatchObject({ user: { id: signedIn.user.id } })
    expect((await signIn(signedIn.user.email)).user.id).toBe(signedIn.user.id)
  })

  it('does not commit a new password when revoking existing sessions fails', async () => {
    const first = await signUp()
    const second = await signIn(first.user.email)
    await requirePasswordChange(first.user.id)
    const accountsBefore = await testDb.select().from(authAccount)
    const sessionsBefore = await testDb.select().from(authSession)
    const adapter = (await getAuth().$context).internalAdapter
    const failedRevoke = vi.spyOn(adapter, 'deleteUserSessions').mockRejectedValueOnce(new Error('Injected session revocation failure'))

    const changed = await request('change-password', {
      currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true,
    }, { cookie: first.cookie })
    failedRevoke.mockRestore()
    expect(changed.status).toBe(500)
    expect(await testDb.select().from(authAccount)).toEqual(accountsBefore)
    expect(await testDb.select().from(authSession)).toEqual(sessionsBefore)
    expect(await sessionFor({ cookie: first.cookie })).toMatchObject({ user: { mustChangePassword: true } })
    expect(await sessionFor(bearer(second.token))).toMatchObject({ user: { mustChangePassword: true } })
    expect((await request('sign-in/email', { email: first.user.email, password: NEW_PASSWORD })).status).toBe(401)
    expect((await signIn(first.user.email)).user.id).toBe(first.user.id)
  })

  it('runs the password-update hook for a retained write when replacement-session creation fails', async () => {
    const first = await signUp()
    const second = await signIn(first.user.email)
    await requirePasswordChange(first.user.id)
    const adapter = (await getAuth().$context).internalAdapter
    const failedCreate = vi.spyOn(adapter, 'createSession').mockRejectedValueOnce(new Error('Injected session creation failure'))

    const changed = await request('change-password', {
      currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true,
    }, { cookie: first.cookie })
    failedCreate.mockRestore()
    expect(changed.status).toBe(500)
    // The app deliberately uses the adapter without interactive transactions.
    // Revocation and the password write persist even when the later step fails;
    // the account.update.after hook must reflect that retained password write.
    expect(await sessionFor({ cookie: first.cookie })).toBeNull()
    expect(await sessionFor(bearer(second.token))).toBeNull()
    expect(await testDb.select().from(authSession)).toHaveLength(0)
    const storedUser = await testDb.select().from(user).where(eq(user.id, first.user.id)).get()
    expect(storedUser?.mustChangePassword).toBe(false)
    expect((await request('sign-in/email', { email: first.user.email, password: PASSWORD })).status).toBe(401)
    expect((await signIn(first.user.email, NEW_PASSWORD)).user.id).toBe(first.user.id)
  })
})

describe('persisted sessions', () => {
  it('uses the configured lifetime and accepts the same cookie and bearer after auth is recreated', async () => {
    const started = Date.now()
    const signedIn = await signUp()
    const row = await sessionRow(signedIn.token)
    expect(row?.expiresAt.getTime()).toBeGreaterThanOrEqual(started + LIFETIME_MS - 1000)
    expect(row?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + LIFETIME_MS)
    expect(row?.creationMethod).toBe('password')

    resetAuth()
    expect(await sessionFor({ cookie: signedIn.cookie })).toMatchObject({
      session: { id: row!.id, token: signedIn.token }, user: { id: signedIn.user.id },
    })
    expect(await sessionFor(bearer(signedIn.token))).toMatchObject({ user: { id: signedIn.user.id } })
    expect(await sessionRow(signedIn.token)).toEqual(row)
  })

  it('rejects an expired session through both cookie and bearer authentication', async () => {
    const signedIn = await signUp()
    await testDb.update(authSession).set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(authSession.token, signedIn.token))
    expect(await sessionFor({ cookie: signedIn.cookie })).toBeNull()
    expect(await sessionFor(bearer(signedIn.token))).toBeNull()
  })

  it('signs out only the calling session and invalidates its cookie and bearer', async () => {
    const first = await signUp()
    const second = await signIn(first.user.email)
    const signedOut = await request('sign-out', {}, { cookie: first.cookie })
    expect(signedOut.status).toBe(200)
    expect(await sessionFor({ cookie: first.cookie })).toBeNull()
    expect(await sessionFor(bearer(first.token))).toBeNull()
    expect(await sessionFor(bearer(second.token))).toMatchObject({ user: { id: first.user.id } })
    expect(await testDb.select().from(authSession)).toHaveLength(1)
  })

  it('cannot revoke another user’s session by supplying its token', async () => {
    const first = await signUp()
    const second = await signUp('other-session@example.com')
    const revoke = await request('revoke-session', { token: second.token }, { cookie: first.cookie })
    // The endpoint deliberately does not reveal whether another user's token exists.
    expect(revoke.status).toBe(200)
    expect(await sessionFor(bearer(first.token))).toMatchObject({ user: { id: first.user.id } })
    expect(await sessionFor(bearer(second.token))).toMatchObject({ user: { id: second.user.id } })
  })
})
