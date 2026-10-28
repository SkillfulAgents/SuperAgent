import { afterEach, beforeEach, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { llmConnections } from '../schema'
import { runDataMigrations } from './index'
import { renameDefaultConnections } from './0004-rename-default-connections'

let handle: TestDatabase
beforeEach(async () => { handle = await createTestDatabase() })
afterEach(async () => { await handle.close() })

const row = (id: string, provider: string, name: string) => ({
  id, provider, name, config: '{}', createdAt: new Date(), updatedAt: new Date(),
})

it('renames rows still on an old default name and leaves chosen names alone, idempotently', async () => {
  await handle.db.insert(llmConnections).values([
    row('a', 'anthropic', 'Anthropic'),
    row('b', 'anthropic', 'Team key'),
    row('p', 'platform', 'Platform'),
    row('o', 'openrouter', 'Anthropic'),
  ]).run()
  expect(await runDataMigrations(handle.db, [renameDefaultConnections])).toEqual([4])
  await renameDefaultConnections.run(handle.db)
  const names = Object.fromEntries((await handle.db.select().from(llmConnections).all()).map(r => [r.id, r.name]))
  expect(names).toEqual({ a: 'Anthropic API', b: 'Team key', p: 'Gamut Platform', o: 'Anthropic' })
})
