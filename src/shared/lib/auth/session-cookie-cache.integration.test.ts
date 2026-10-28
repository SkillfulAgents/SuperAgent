/**
 * The session cookie cache on the real Better Auth endpoints, adapter and cookies: with it on, a
 * signed-in browser's session is read from its signed cookie; with it off, from the database on
 * every request. The session row is deleted to tell the two apart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { authSession } from '../db/schema'

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

const BASE = 'http://localhost:47892'

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

async function signedInBrowser() {
  const response = await request('sign-up/email', { email: 'cookie-cache@example.com', password: 'CookieCachePassword123!', name: 'Cookie Cache' })
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
  handle = await createTestDatabase()
  testDb = handle.db
  resetAuth()
})

afterEach(async () => {
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
})
