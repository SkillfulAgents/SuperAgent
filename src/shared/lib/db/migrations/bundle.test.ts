import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { migrationBundle } from './bundle'

describe('migration bundle', () => {
  it('matches the SQL files and journal in this folder (run `npm run db:bundle` after `drizzle-kit generate`)', () => {
    const fromFolder = readMigrationFiles({ migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
    expect(migrationBundle).toEqual(fromFolder)
  })
})
