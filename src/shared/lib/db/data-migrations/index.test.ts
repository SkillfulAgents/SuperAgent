import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../schema'

// The bundled migration reads the agents data directory; the runner is
// exercised with migrations of its own here, so none of that is needed.
vi.mock('./0001-import-agents-from-directories', () => ({
  importAgentsFromDirectories: { id: 1, name: 'stub', run: () => {} },
}))

import { runDataMigrations, type DataMigration } from './index'

let sqlite: InstanceType<typeof Database>
let db: ReturnType<typeof drizzle<typeof schema>>

function ledger() {
  return db.select().from(schema.dataMigrations).orderBy(schema.dataMigrations.id).all().map((row) => [row.id, row.name])
}

function migration(id: number, name: string, log: string[]): DataMigration {
  return {
    id,
    name,
    run(tx) {
      log.push(name)
      tx.insert(schema.agents).values({ slug: `from-${name}`, name, createdAt: new Date() }).run()
    },
  }
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/shared/lib/db/migrations' })
})

afterEach(() => {
  sqlite.close()
})

describe('runDataMigrations', () => {
  it('applies pending migrations in id order once, records them, and skips them on the next boot', () => {
    const log: string[] = []
    const migrations = [migration(2, 'second', log), migration(1, 'first', log)]

    expect(runDataMigrations(db, migrations)).toEqual([1, 2])
    expect(log).toEqual(['first', 'second'])
    expect(ledger()).toEqual([[1, 'first'], [2, 'second']])

    expect(runDataMigrations(db, migrations)).toEqual([])
    expect(log).toEqual(['first', 'second'])
  })

  it('applies only the migrations the ledger does not list', () => {
    const log: string[] = []
    runDataMigrations(db, [migration(1, 'first', log)])

    expect(runDataMigrations(db, [migration(1, 'first', log), migration(2, 'second', log)])).toEqual([2])
    expect(log).toEqual(['first', 'second'])
    expect(ledger()).toEqual([[1, 'first'], [2, 'second']])
  })

  it('re-applies everything after the ledger is gone, as a lost database would', () => {
    const log: string[] = []
    const migrations = [migration(1, 'first', log)]
    runDataMigrations(db, migrations)
    db.delete(schema.dataMigrations).run()
    db.delete(schema.agents).run()

    expect(runDataMigrations(db, migrations)).toEqual([1])
    expect(log).toEqual(['first', 'first'])
    expect(db.select().from(schema.agents).all().map((row) => row.slug)).toEqual(['from-first'])
  })

  it('records nothing for a failing migration, leaves later ones unapplied, and re-runs it on the next boot', () => {
    // There is no transaction around run + ledger row, so the contract is on
    // the migration: it must be idempotent, and what it wrote before failing
    // is visible to its next attempt.
    const log: string[] = []
    let attempts = 0
    const flaky: DataMigration = {
      id: 2,
      name: 'flaky',
      run(tx) {
        attempts++
        tx.insert(schema.agents).values({ slug: 'from-flaky', name: 'Flaky', createdAt: new Date() }).onConflictDoNothing().run()
        if (attempts === 1) throw new Error('migration failed')
      },
    }
    const migrations = [migration(1, 'first', log), flaky, migration(3, 'third', log)]

    expect(() => runDataMigrations(db, migrations)).toThrow('migration failed')
    expect(ledger()).toEqual([[1, 'first']])
    expect(log).toEqual(['first'])
    expect(db.select().from(schema.agents).all().map((row) => row.slug)).toEqual(['from-first', 'from-flaky'])

    expect(runDataMigrations(db, migrations)).toEqual([2, 3])
    expect(attempts).toBe(2)
    expect(ledger()).toEqual([[1, 'first'], [2, 'flaky'], [3, 'third']])
    expect(db.select().from(schema.agents).all().map((row) => row.slug)).toEqual(['from-first', 'from-flaky', 'from-third'])
  })

  it('refuses a list that reuses an id', () => {
    const log: string[] = []
    expect(() => runDataMigrations(db, [migration(1, 'a', log), migration(1, 'b', log)])).toThrow('used twice')
    expect(ledger()).toEqual([])
  })
})
