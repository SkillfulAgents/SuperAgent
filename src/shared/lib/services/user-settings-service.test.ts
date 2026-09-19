import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '../db/schema'
import type { AppDatabase } from '../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'

let testDb: AppDatabase
let handle: TestDatabase

vi.mock('../db', () => ({
  get db() { return testDb },
}))

import { getDefaultUserSettings, getUserSettings, updateUserSettings } from './user-settings-service'

describe('user-settings-service', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
  })

  afterEach(async () => {
    await handle.close()
  })

  it('returns the defaults and seeds a row for a user with none', async () => {
    expect(await getUserSettings('u1')).toEqual(getDefaultUserSettings())
    const rows = await testDb.select().from(schema.userSettings).where(eq(schema.userSettings.userId, 'u1')).all()
    expect(rows).toHaveLength(1)
  })

  it('merges a partial update into the stored document', async () => {
    await updateUserSettings('u1', { theme: 'dark' })
    const updated = await updateUserSettings('u1', { notifications: { ...getDefaultUserSettings().notifications, sessionComplete: false } })
    expect(updated.theme).toBe('dark')
    expect(updated.notifications.sessionComplete).toBe(false)
    expect(updated.notifications.enabled).toBe(true) // untouched nested field survives
    expect(await getUserSettings('u1')).toEqual(updated)
  })

  it('keeps every field when two updates overlap', async () => {
    // Each update reads, merges and writes with awaits in between. Without a
    // compare-and-swap the second read sees the first's snapshot and its
    // write silently reverts the first's change.
    await Promise.all([
      updateUserSettings('u1', { theme: 'dark' }),
      updateUserSettings('u1', { autoCheckUpdates: false }),
    ])
    const settings = await getUserSettings('u1')
    expect(settings.theme).toBe('dark')
    expect(settings.autoCheckUpdates).toBe(false)
  })

  it('merges onto a write that landed between its read and its write', async () => {
    await updateUserSettings('u1', { theme: 'light' })
    // Another process changes the document while this update is in flight:
    // the first select of the update has happened when this write lands.
    const intrude = () => testDb.update(schema.userSettings)
      .set({ settings: JSON.stringify({ ...getDefaultUserSettings(), theme: 'dark' }) })
      .where(eq(schema.userSettings.userId, 'u1')).run()
    // Wrap the builder chain so the terminal get() of the next select runs the
    // intruding write after it has read.
    const afterGet = (builder: object): object => new Proxy(builder, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== 'function') return value
        if (prop === 'get') {
          return async (...args: unknown[]) => {
            const row = await value.apply(target, args)
            await intrude()
            return row
          }
        }
        return (...args: unknown[]) => {
          const out = value.apply(target, args)
          return out && typeof out === 'object' ? afterGet(out) : out
        }
      },
    })
    const select = testDb.select.bind(testDb)
    let intruded = false
    vi.spyOn(testDb, 'select').mockImplementation(((...args: unknown[]) => {
      const query = (select as (...a: unknown[]) => object)(...args)
      if (intruded) return query
      intruded = true
      return afterGet(query)
    }) as never)

    const updated = await updateUserSettings('u1', { autoCheckUpdates: false })
    expect(updated.theme).toBe('dark') // the intruding write was re-read, not overwritten
    expect(updated.autoCheckUpdates).toBe(false)
  })
})
