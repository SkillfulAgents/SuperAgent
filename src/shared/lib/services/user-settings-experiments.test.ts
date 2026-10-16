import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { user } from '@shared/lib/db/schema'

let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/experiments/registry', () => ({
  EXPERIMENTS: [
    { id: 'alpha', name: 'Alpha', description: 'The first one.' },
    { id: 'beta', name: 'Beta', description: 'The second one.' },
  ],
}))

import { getUserSettings, isExperimentEnabled, updateUserSettings } from './user-settings-service'

const USER_ID = 'user-1'
let handle: TestDatabase

beforeEach(async () => {
  handle = await createTestDatabase()
  testDb = handle.db
  await testDb.insert(user).values({ id: USER_ID, name: 'Test', email: 'test@example.com' }).run()
})

afterEach(async () => {
  await handle.close()
})

describe('experiment switches', () => {
  it('start off', async () => {
    expect(await isExperimentEnabled(USER_ID, 'alpha' as never)).toBe(false)
  })

  it('turn on and off for the user', async () => {
    await updateUserSettings(USER_ID, { experiments: { alpha: true } })
    expect(await isExperimentEnabled(USER_ID, 'alpha' as never)).toBe(true)
    await updateUserSettings(USER_ID, { experiments: { alpha: false } })
    expect(await isExperimentEnabled(USER_ID, 'alpha' as never)).toBe(false)
  })

  it('a write merges into the map: toggling one leaves the others as they were', async () => {
    await updateUserSettings(USER_ID, { experiments: { alpha: true } })
    await updateUserSettings(USER_ID, { experiments: { beta: true } })
    expect((await getUserSettings(USER_ID)).experiments).toEqual({ alpha: true, beta: true })
  })

  it('concurrent toggles of different experiments both land', async () => {
    await Promise.all([
      updateUserSettings(USER_ID, { experiments: { alpha: true } }),
      updateUserSettings(USER_ID, { experiments: { beta: true } }),
    ])
    expect((await getUserSettings(USER_ID)).experiments).toEqual({ alpha: true, beta: true })
  })

  it('an unrelated settings write keeps the switches', async () => {
    await updateUserSettings(USER_ID, { experiments: { alpha: true } })
    await updateUserSettings(USER_ID, { theme: 'dark' })
    expect(await isExperimentEnabled(USER_ID, 'alpha' as never)).toBe(true)
  })
})
