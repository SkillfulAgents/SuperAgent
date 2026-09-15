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

  it('rolls a failing migration back with its ledger entry and leaves later ones unapplied', () => {
    const log: string[] = []
    const failing: DataMigration = {
      id: 2,
      name: 'failing',
      run(tx) {
        tx.insert(schema.agents).values({ slug: 'half-written', name: 'Half', createdAt: new Date() }).run()
        throw new Error('migration failed')
      },
    }

    expect(() => runDataMigrations(db, [migration(1, 'first', log), failing, migration(3, 'third', log)])).toThrow('migration failed')

    expect(ledger()).toEqual([[1, 'first']])
    expect(db.select().from(schema.agents).all().map((row) => row.slug)).toEqual(['from-first'])
    expect(log).toEqual(['first'])
  })

  it('refuses a list that reuses an id', () => {
    const log: string[] = []
    expect(() => runDataMigrations(db, [migration(1, 'a', log), migration(1, 'b', log)])).toThrow('used twice')
    expect(ledger()).toEqual([])
  })
})
