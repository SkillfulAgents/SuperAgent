/**
 * The whole API app reads the settings record once per request: the scope its
 * first middleware opens is shared by the route's middleware, its handler and
 * the services they call (see config/settings-request-memo.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let handle: TestDatabase
vi.mock('@shared/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/db')>()),
  get db() {
    return handle.db
  },
}))

import * as records from '@shared/lib/app-records/records'
import { SETTINGS_RECORD_KEY } from '@shared/lib/app-records/record-schemas'
import { getSettings, mutateSettings } from '@shared/lib/config/settings'
import app from './index'

let reads: MockInstance<typeof records.readStoredRecord>
const settingsReads = () => reads.mock.calls.filter(([key]) => key === SETTINGS_RECORD_KEY).length

beforeEach(async () => {
  handle = await createTestDatabase()
  await mutateSettings((s) => { s.app = { ...s.app, theme: 'dark' } })
  reads = vi.spyOn(records, 'readStoredRecord')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await handle.close()
})

describe('settings reads per API request', () => {
  // The handler reads the settings, and so do the host-browser providers and
  // the other helpers the response is built from: three reads without the scope.
  it('GET /api/settings reads the settings record once', async () => {
    const res = await app.request('/api/settings')
    expect(res.status).toBe(200)
    expect(settingsReads()).toBe(1)
  })

  it('the next request reads again', async () => {
    await app.request('/api/settings')
    await app.request('/api/settings')
    expect(settingsReads()).toBe(2)
  })

  it('a request that saves settings answers with what it saved, and later reads see it', async () => {
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: { theme: 'light' } }),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { app?: { theme?: string } }).app?.theme).toBe('light')
    expect((await getSettings()).app?.theme).toBe('light')
  })
})
