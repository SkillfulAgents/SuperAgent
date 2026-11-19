/**
 * getAuth() reads what the Better Auth instance is built from on every call, and every
 * authenticated request waits for it. Settings and the secret are read together, not one
 * after the other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { AUTH_SECRET_RECORD_KEY } from '../app-records/record-schemas'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

const AUTH_SETTINGS = { requireAdminApproval: false, sessionMaxLifetimeHrs: 2, sessionIdleTimeoutMin: 60 }
const settingsRead = vi.hoisted(() => ({ read: undefined as undefined | (() => Promise<unknown>) }))
vi.mock('@shared/lib/config/settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/config/settings')>(),
  getSettings: () => settingsRead.read!(),
}))

const secretRead = vi.hoisted(() => ({ read: undefined as undefined | (() => Promise<string>) }))
vi.mock('./secret', async (importOriginal) => {
  const original = await importOriginal<typeof import('./secret')>()
  return { ...original, getOrCreateAuthSecret: () => (secretRead.read ?? original.getOrCreateAuthSecret)() }
})

import { getAuth, resetAuth } from './index'
import { readStoredRecord } from '../app-records/records'
import * as schema from '../db/schema'

/** A read that starts at once and answers when `answer()` runs, like a statement on the network. */
function slowRead<T>(events: string[], name: string, value: T | Error) {
  let answer!: () => void
  const answered = new Promise<void>((resolve) => { answer = resolve })
  const read = async (): Promise<T> => {
    events.push(`${name} asked`)
    await answered
    events.push(`${name} answered`)
    if (value instanceof Error) throw value
    return value
  }
  return { read, answer }
}

beforeEach(async () => {
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('BETTER_AUTH_SECRET', '')
  vi.stubEnv('TRUSTED_ORIGINS', 'http://localhost:47892')
  vi.stubEnv('AUTH_PROVIDERS_JSON', '[]')
  vi.stubEnv('PLATFORM_TOKEN', '')
  handle = await createTestDatabase()
  testDb = handle.db
  settingsRead.read = async () => ({ auth: AUTH_SETTINGS })
  secretRead.read = undefined
  resetAuth()
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetAuth()
  await handle.close()
})

describe('reading what the auth instance is built from', () => {
  it('asks for the secret before the settings have answered', async () => {
    const events: string[] = []
    const settings = slowRead(events, 'settings', { auth: AUTH_SETTINGS })
    const secret = slowRead(events, 'secret', 'inputs-test-secret-0123456789abcdef0123456789abcdef')
    settingsRead.read = settings.read
    secretRead.read = secret.read

    const auth = getAuth()
    await new Promise((resolve) => setImmediate(resolve))
    expect(events).toEqual(['settings asked', 'secret asked'])

    secret.answer()
    settings.answer()
    expect(await auth).toBeDefined()
  })

  it('builds the same instance from the same settings and secret, and a new one when either changes', async () => {
    const first = await getAuth()
    expect(await getAuth()).toBe(first)

    settingsRead.read = async () => ({ auth: { ...AUTH_SETTINGS, sessionMaxLifetimeHrs: 8 } })
    const afterSettings = await getAuth()
    expect(afterSettings).not.toBe(first)

    secretRead.read = async () => 'another-test-secret-0123456789abcdef0123456789abcdef'
    expect(await getAuth()).not.toBe(afterSettings)
  })

  it('creates the secret on first use beside the settings read, and keeps it', async () => {
    expect(await readStoredRecord(AUTH_SECRET_RECORD_KEY)).toBeNull()

    const first = await getAuth()
    const stored = await readStoredRecord(AUTH_SECRET_RECORD_KEY)
    expect(stored).not.toBeNull()

    expect(await getAuth()).toBe(first)
    expect(await readStoredRecord(AUTH_SECRET_RECORD_KEY)).toEqual(stored)
  })

  it('fails when the settings cannot be read, whatever the secret read does', async () => {
    const events: string[] = []
    const settings = slowRead(events, 'settings', new Error('settings unavailable'))
    const secret = slowRead<string>(events, 'secret', new Error('secret unavailable'))
    settingsRead.read = settings.read
    secretRead.read = secret.read

    const auth = getAuth()
    settings.answer()
    await expect(auth).rejects.toThrow('settings unavailable')
    // The read still in flight fails after the call has: it must not become an unhandled rejection.
    secret.answer()
    await new Promise((resolve) => setImmediate(resolve))
    expect(events).toContain('secret answered')
  })

  it('fails when the secret cannot be read', async () => {
    secretRead.read = async () => { throw new Error('secret unavailable') }
    await expect(getAuth()).rejects.toThrow('secret unavailable')
  })
})

// Why a request waits for getAuth() before it reads its session, instead of starting the read
// on the instance the process already has and discarding the answer when the inputs changed.
describe('an instance built from older settings', () => {
  const BASE = 'http://localhost:47892'
  const hoursLeft = async () =>
    ((await testDb.select().from(schema.authSession).get())!.expiresAt.getTime() - Date.now()) / 3600_000

  it('still refreshes a session with its own, older lifetime', async () => {
    settingsRead.read = async () => ({ auth: { ...AUTH_SETTINGS, sessionMaxLifetimeHrs: 720 } })
    const older = await getAuth()
    const signedUp = await older.handler(new Request(`${BASE}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'older-instance@example.com', password: 'OlderInstance123!', name: 'Older Instance' }),
    }))
    const headers = new Headers({ cookie: signedUp.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ') })

    // An admin shortens sessions to 8 hours, and this session is refreshed under that.
    settingsRead.read = async () => ({ auth: { ...AUTH_SETTINGS, sessionMaxLifetimeHrs: 8 } })
    const current = await getAuth()
    await testDb.update(schema.authSession).set({ expiresAt: new Date(Date.now() + 8 * 3600_000) }).run()
    await current.api.getSession({ headers })
    expect(await hoursLeft()).toBeLessThanOrEqual(8)

    // One read on the older instance gives it 30 days, and the current instance leaves that alone.
    await older.api.getSession({ headers })
    expect(await hoursLeft()).toBeGreaterThan(700)
    await current.api.getSession({ headers })
    expect(await hoursLeft()).toBeGreaterThan(700)
  })
})
