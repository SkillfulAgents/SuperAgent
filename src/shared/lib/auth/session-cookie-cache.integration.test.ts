/**
 * The session cookie cache on the real Better Auth endpoints, adapter and cookies: with it on, a
 * signed-in browser's session is read from its signed cookie; with it off, from the database on
 * every request. The session row is deleted to tell the two apart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { authSession, user } from '../db/schema'

let handle: TestDatabase
let testDb: AppDatabase
const auth: { sessionCookieCacheSeconds?: number } = {}

vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/config/settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/config/settings')>(),
  getSettings: () => ({
    auth: {
      requireAdminApproval: false,
      maxConcurrentSessions: 12,
      sessionMaxLifetimeHrs: 2,
      sessionIdleTimeoutMin: 60,
      ...auth,
    },
  }),
}))

import { getAuth, resetAuth } from './index'
import { Authenticated } from '@/api/middleware/auth'

const BASE = 'http://localhost:47892'
const PASSWORD = 'CookieCachePassword123!'

async function request(endpoint: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  return (await getAuth()).handler(new Request(`${BASE}/api/auth/${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: { origin: BASE, 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }))
}

/** Apply Set-Cookie in order, including replacements and deletions, like a browser. */
function cookiesOf(response: Response, previous = ''): string {
  const cookies = new Map(previous.split('; ').filter(Boolean).map(pair => [pair.slice(0, pair.indexOf('=')), pair]))
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(';')[0]
    const name = pair.slice(0, pair.indexOf('='))
    if (/max-age=0(?:;|$)/i.test(value)) cookies.delete(name)
    else cookies.set(name, pair)
  }
  return [...cookies.values()].join('; ')
}

async function signedInBrowser() {
  const response = await request('sign-up/email', { email: 'cookie-cache@example.com', password: PASSWORD, name: 'Cookie Cache' })
  expect(response.status).toBe(200)
  const { token } = await response.json() as { token: string }
  return { token, cookie: cookiesOf(response) }
}

async function sessionUserEmail(cookie: string): Promise<string | null> {
  const response = await request('get-session', undefined, { cookie })
  expect(response.status).toBe(200)
  const body = await response.json() as { user: { email: string } } | null
  return body?.user.email ?? null
}

beforeEach(async () => {
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('BETTER_AUTH_SECRET', 'cookie-cache-test-secret-0123456789abcdef0123456789abcdef')
  vi.stubEnv('TRUSTED_ORIGINS', BASE)
  vi.stubEnv('AUTH_PROVIDERS_JSON', '[]')
  vi.stubEnv('PLATFORM_TOKEN', '')
  handle = await createTestDatabase()
  testDb = handle.db
  resetAuth()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  delete auth.sessionCookieCacheSeconds
  resetAuth()
  await handle.close()
})

describe('session cookie cache', () => {
  it('reads the session from the database on every request by default', async () => {
    const browser = await signedInBrowser()
    expect(await sessionUserEmail(browser.cookie)).toBe('cookie-cache@example.com')

    await testDb.delete(authSession).where(eq(authSession.token, browser.token))

    expect(await sessionUserEmail(browser.cookie)).toBeNull()
  })

  it('reads the session from its signed cookie while the cache is on', async () => {
    auth.sessionCookieCacheSeconds = 300
    const browser = await signedInBrowser()
    expect(await sessionUserEmail(browser.cookie)).toBe('cookie-cache@example.com')

    await testDb.delete(authSession).where(eq(authSession.token, browser.token))

    expect(await sessionUserEmail(browser.cookie)).toBe('cookie-cache@example.com')
  })

  it.each([false, true])('refreshes the password-change flag with revokeOtherSessions=%s', async (revokeOtherSessions) => {
    auth.sessionCookieCacheSeconds = 120
    const browser = await signedInBrowser()
    const session = await testDb.select().from(authSession).where(eq(authSession.token, browser.token)).get()
    await testDb.update(user).set({ mustChangePassword: true }).where(eq(user.id, session!.userId)).run()
    const login = await request('sign-in/email', { email: 'cookie-cache@example.com', password: PASSWORD })
    expect(login.status).toBe(200)
    const cookie = cookiesOf(login)
    expect(await (await request('get-session', undefined, { cookie })).json()).toMatchObject({ user: { mustChangePassword: true } })

    const changed = await request('change-password', {
      currentPassword: PASSWORD, newPassword: 'ReplacementPassword456!', revokeOtherSessions,
    }, { cookie })
    expect(changed.status).toBe(200)
    expect(await testDb.select({ mustChangePassword: user.mustChangePassword }).from(user).where(eq(user.id, session!.userId)).get())
      .toEqual({ mustChangePassword: false })

    const adapter = (await (await getAuth()).$context).internalAdapter
    const reads = vi.spyOn(adapter, 'findSession')
    const refreshed = await request('get-session', undefined, { cookie: cookiesOf(changed, cookie) })
    expect(refreshed.status).toBe(200)
    expect(await refreshed.json()).toMatchObject({ user: { mustChangePassword: false } })
    expect(reads).not.toHaveBeenCalled()
  })

  it('renews an expired cache through an ordinary authenticated API response', async () => {
    auth.sessionCookieCacheSeconds = 120
    const browser = await signedInBrowser()
    const app = new Hono()
    app.get('/', Authenticated(), c => c.json({ ok: true }))
    const adapter = (await (await getAuth()).$context).internalAdapter
    const reads = vi.spyOn(adapter, 'findSession')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 121_000)
    // The browser drops the expired cache cookie but retains its session token.
    const cookie = browser.cookie.split('; ').filter(pair => !pair.includes('session_data')).join('; ')

    const refreshed = await app.request('/', { headers: { cookie } })
    expect(refreshed.status).toBe(200)
    expect(reads).toHaveBeenCalledTimes(1)
    expect(refreshed.headers.getSetCookie().some(value => value.includes('session_data='))).toBe(true)
    const refreshedCookie = cookiesOf(refreshed, cookie)
    reads.mockClear()

    expect((await app.request('/', { headers: { cookie: refreshedCookie } })).status).toBe(200)
    expect(reads).not.toHaveBeenCalled()
  })

  it('keeps the password-change requirement after an incorrect password', async () => {
    auth.sessionCookieCacheSeconds = 120
    const browser = await signedInBrowser()
    const session = await testDb.select().from(authSession).where(eq(authSession.token, browser.token)).get()
    await testDb.update(user).set({ mustChangePassword: true }).where(eq(user.id, session!.userId)).run()
    const login = await request('sign-in/email', { email: 'cookie-cache@example.com', password: PASSWORD })
    expect(login.status).toBe(200)
    const cookie = cookiesOf(login)

    const failed = await request('change-password', {
      currentPassword: 'WrongPassword123!', newPassword: 'ReplacementPassword456!', revokeOtherSessions: true,
    }, { cookie })
    expect(failed.status).toBe(400)
    const refreshed = await request('get-session', undefined, { cookie: cookiesOf(failed, cookie) })
    expect(await refreshed.json()).toMatchObject({ user: { mustChangePassword: true } })
    expect((await request('sign-in/email', { email: 'cookie-cache@example.com', password: PASSWORD })).status).toBe(200)
  })
})
