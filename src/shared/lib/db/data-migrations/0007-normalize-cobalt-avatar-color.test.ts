import { afterEach, beforeEach, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { agents } from '../schema'
import { runDataMigrations } from './index'
import { normalizeCobaltAvatarColor } from './0007-normalize-cobalt-avatar-color'

let handle: TestDatabase
beforeEach(async () => { handle = await createTestDatabase() })
afterEach(async () => { await handle.close() })

it('renames only the legacy ID and preserves all other agent data across retries', async () => {
  await handle.db.insert(agents).values([
    { slug: 'legacy', name: 'Legacy', avatarColor: 'Cobalt', avatarShape: 'arch', createdAt: new Date() },
    { slug: 'canonical', name: 'Canonical', avatarColor: 'tonal-cobalt', avatarShape: 'bloom', createdAt: new Date() },
    { slug: 'duo', name: 'Duo', avatarColor: 'duo-cobalt-teal', avatarShape: 'hexagon', createdAt: new Date() },
    { slug: 'other', name: 'Other', avatarColor: 'tonal-green', avatarShape: 'triangle', createdAt: new Date() },
  ]).run()
  const before = await handle.db.select().from(agents).orderBy(agents.slug).all()
  const expected = before.map(row => row.slug === 'legacy' ? { ...row, avatarColor: 'tonal-cobalt' } : row)

  // Simulate finishing the update and crashing before the ledger is written.
  await normalizeCobaltAvatarColor.run(handle.db)
  expect(await handle.db.select().from(agents).orderBy(agents.slug).all()).toEqual(expected)
  expect(await runDataMigrations(handle.db, [normalizeCobaltAvatarColor])).toEqual([7])
  expect(await handle.db.select().from(agents).orderBy(agents.slug).all()).toEqual(expected)
  expect(await runDataMigrations(handle.db, [normalizeCobaltAvatarColor])).toEqual([])
})

it('does nothing to an empty database', async () => {
  expect(await runDataMigrations(handle.db, [normalizeCobaltAvatarColor])).toEqual([7])
  expect(await handle.db.select().from(agents).all()).toEqual([])
})
