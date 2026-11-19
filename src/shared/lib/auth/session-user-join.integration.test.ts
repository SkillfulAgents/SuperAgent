/**
 * Better Auth reads a session with its user, an account with its user, and a user with their
 * accounts. On the real endpoints and adapter: each is one query through the schema's relations,
 * and sign-up, sign-in and the session read still return the same data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'

let handle: TestDatabase
let testDb: AppDatabase

vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/config/settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/config/settings')>(),
  getSettings: () => ({ auth: { requireAdminApproval: false, maxConcurrentSessions: 12, sessionMaxLifetimeHrs: 2, sessionIdleTimeoutMin: 60 } }),
}))

import { getAuth, resetAuth } from './index'

const BASE = 'http://localhost:47892'
const PASSWORD = 'SessionJoinPassword123!'
const EMAIL = 'session-join@example.com'

async function request(endpoint: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  return (await getAuth()).handler(new Request(`${BASE}/api/auth/${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: { origin: BASE, 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }))
}

const cookieOf = (response: Response) => response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')

beforeEach(async () => {
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('BETTER_AUTH_SECRET', 'session-join-test-secret-0123456789abcdef0123456789abcdef')
  vi.stubEnv('TRUSTED_ORIGINS', BASE)
  vi.stubEnv('AUTH_PROVIDERS_JSON', '[]')
  vi.stubEnv('PLATFORM_TOKEN', '')
  handle = await createTestDatabase()
  testDb = handle.db
  resetAuth()
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetAuth()
  await handle.close()
})

describe('session and user in one query', () => {
  it('reads a signed-in session and its user through the relation, with no second query', async () => {
    const signedUp = await request('sign-up/email', { email: EMAIL, password: PASSWORD, name: 'Session Join' })
    expect(signedUp.status).toBe(200)

    const joined = vi.spyOn(testDb.query.authSession, 'findFirst')
    const separate = vi.spyOn(testDb, 'select')
    const session = await request('get-session', undefined, { cookie: cookieOf(signedUp) })

    expect(await session.json()).toMatchObject({ user: { email: EMAIL, name: 'Session Join' }, session: { userId: expect.any(String) } })
    expect(joined).toHaveBeenCalledTimes(1)
    expect(separate).not.toHaveBeenCalled()
  })

  it('signs in with a password, which reads the user with their accounts', async () => {
    expect((await request('sign-up/email', { email: EMAIL, password: PASSWORD, name: 'Session Join' })).status).toBe(200)

    const joined = vi.spyOn(testDb.query.user, 'findFirst')
    const signedIn = await request('sign-in/email', { email: EMAIL, password: PASSWORD })

    expect(signedIn.status).toBe(200)
    expect(await signedIn.json()).toMatchObject({ user: { email: EMAIL } })
    expect(joined).toHaveBeenCalled()
  })

  it('refuses a wrong password', async () => {
    expect((await request('sign-up/email', { email: EMAIL, password: PASSWORD, name: 'Session Join' })).status).toBe(200)

    expect((await request('sign-in/email', { email: EMAIL, password: 'WrongPassword456!' })).status).toBe(401)
  })
})
