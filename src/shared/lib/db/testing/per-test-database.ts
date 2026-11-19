/**
 * A fresh test database for every test of a file, for code that reaches the
 * database through `db` from `@shared/lib/db` (a local session store's index,
 * for one). Call it at the top of the file, ahead of the file's own hooks:
 *
 *   const database = perTestDatabase()
 *   vi.mock('@shared/lib/db', () => ({ get db() { return database.db } }))
 */
import { afterEach, beforeEach } from 'vitest'
import type { AppDatabase } from '../drivers/types'
import { createTestDatabase, type TestDatabase } from './create-test-database'

export function perTestDatabase(): { readonly db: AppDatabase } {
  let handle: TestDatabase | undefined
  beforeEach(async () => {
    handle = await createTestDatabase()
  })
  afterEach(async () => {
    await handle?.close()
    handle = undefined
  })
  return {
    get db() {
      if (!handle) throw new Error('The test database is only open while a test runs')
      return handle.db
    },
  }
}
