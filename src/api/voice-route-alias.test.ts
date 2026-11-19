import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import app from './index'

let handle: TestDatabase
let testDb: TestDatabase['db']
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

/**
 * The voice router moved from /api/stt to /api/voice when it outgrew speech
 * recognition (it also mints text-to-speech credentials).
 * The old prefix stays mounted: the speech-recognition polyfill is cached in
 * browsers for an hour and fetches its token from the prefix it was built
 * with, and third-party dashboards may have the old paths baked in. Assert
 * against the real app so a re-ordering or a dropped mount is caught.
 */
describe('voice routes answer under both prefixes', () => {
  // The voice settings are read from the app database.
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
  })
  afterEach(async () => {
    await handle.close()
  })

  it.each(['/api/voice/configured', '/api/stt/configured'])('%s', async (path) => {
    const res = await app.request(path)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ configured: expect.any(Boolean), supportsTts: expect.any(Boolean) })
  })
})
