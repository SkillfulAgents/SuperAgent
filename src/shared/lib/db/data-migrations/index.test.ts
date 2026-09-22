import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../schema'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'

// The bundled migration reads the agents data directory; the runner is
// exercised with migrations of its own here, so none of that is needed.
vi.mock('./0001-import-agents-from-directories', () => ({
  importAgentsFromDirectories: { id: 1, name: 'stub', run: () => {} },
}))

import { runDataMigrations, type DataMigration } from './index'

let handle: TestDatabase

async function ledger() {
  const rows = await handle.db.select().from(schema.dataMigrations).orderBy(schema.dataMigrations.id).all()
  return rows.map((row) => [row.id, row.name])
}

async function agentSlugs() {
  const rows = await handle.db.select().from(schema.agents).all()
  return rows.map((row) => row.slug)
}

function migration(id: number, name: string, log: string[]): DataMigration {
  return {
    id,
    name,
    async run(tx) {
      log.push(name)
      await tx.insert(schema.agents).values({ slug: `from-${name}`, name, createdAt: new Date() }).run()
    },
  }
}

beforeEach(async () => {
  handle = await createTestDatabase()
})

afterEach(async () => {
  await handle.close()
})

describe('runDataMigrations', () => {
  it('applies pending migrations in id order once, records them, and skips them on the next boot', async () => {
    const log: string[] = []
    const migrations = [migration(2, 'second', log), migration(1, 'first', log)]

    expect(await runDataMigrations(handle.db, migrations)).toEqual([1, 2])
    expect(log).toEqual(['first', 'second'])
    expect(await ledger()).toEqual([[1, 'first'], [2, 'second']])

    expect(await runDataMigrations(handle.db, migrations)).toEqual([])
    expect(log).toEqual(['first', 'second'])
  })

  it('applies only the migrations the ledger does not list', async () => {
    const log: string[] = []
    await runDataMigrations(handle.db, [migration(1, 'first', log)])

    expect(await runDataMigrations(handle.db, [migration(1, 'first', log), migration(2, 'second', log)])).toEqual([2])
    expect(log).toEqual(['first', 'second'])
    expect(await ledger()).toEqual([[1, 'first'], [2, 'second']])
  })

  it('re-applies everything after the ledger is gone, as a lost database would', async () => {
    const log: string[] = []
    const migrations = [migration(1, 'first', log)]
    await runDataMigrations(handle.db, migrations)
    await handle.db.delete(schema.dataMigrations).run()
    await handle.db.delete(schema.agents).run()

    expect(await runDataMigrations(handle.db, migrations)).toEqual([1])
    expect(log).toEqual(['first', 'first'])
    expect(await agentSlugs()).toEqual(['from-first'])
  })

  it('records nothing for a failing migration, leaves later ones unapplied, and re-runs it on the next boot', async () => {
    // There is no transaction around run + ledger row, so the contract is on
    // the migration: it must be idempotent, and what it wrote before failing
    // is visible to its next attempt.
    const log: string[] = []
    let attempts = 0
    const flaky: DataMigration = {
      id: 2,
      name: 'flaky',
      async run(tx) {
        attempts++
        await tx.insert(schema.agents).values({ slug: 'from-flaky', name: 'Flaky', createdAt: new Date() }).onConflictDoNothing().run()
        if (attempts === 1) throw new Error('migration failed')
      },
    }
    const migrations = [migration(1, 'first', log), flaky, migration(3, 'third', log)]

    await expect(runDataMigrations(handle.db, migrations)).rejects.toThrow('migration failed')
    expect(await ledger()).toEqual([[1, 'first']])
    expect(log).toEqual(['first'])
    expect(await agentSlugs()).toEqual(['from-first', 'from-flaky'])

    expect(await runDataMigrations(handle.db, migrations)).toEqual([2, 3])
    expect(attempts).toBe(2)
    expect(await ledger()).toEqual([[1, 'first'], [2, 'flaky'], [3, 'third']])
    expect(await agentSlugs()).toEqual(['from-first', 'from-flaky', 'from-third'])
  })

  it('refuses a list that reuses an id', async () => {
    const log: string[] = []
    await expect(runDataMigrations(handle.db, [migration(1, 'a', log), migration(1, 'b', log)])).rejects.toThrow('used twice')
    expect(await ledger()).toEqual([])
  })
})
