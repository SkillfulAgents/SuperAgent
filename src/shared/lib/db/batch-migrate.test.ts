import { afterEach, describe, expect, it } from 'vitest'
import { createClient, type Client } from '@libsql/client'
import { migrationBundle } from './migrations/bundle'
import { migrateInBatch, type RawBatchClient } from './batch-migrate'
import { libsql } from './drivers/libsql'
import { migrateFromBundle, MIGRATIONS_TABLE } from './open-database'

let client: Client | null = null

afterEach(() => {
  client?.close()
  client = null
})

function rawClient(c: Client): RawBatchClient {
  return {
    query: async (sql) => (await c.execute(sql)).rows.map((row) => Array.from(row)),
    batch: async (statements) => {
      await c.batch(statements, 'write')
    },
  }
}

async function journalCount(c: Client): Promise<number> {
  const result = await c.execute(`SELECT count(*) FROM "${MIGRATIONS_TABLE}"`)
  return Number(result.rows[0][0])
}

describe('migrateInBatch', () => {
  it('applies every bundled migration to an empty database, and a second run changes nothing', async () => {
    client = createClient({ url: ':memory:' })
    await migrateInBatch(rawClient(client), migrationBundle, MIGRATIONS_TABLE)
    expect(await journalCount(client)).toBe(migrationBundle.length)

    await migrateInBatch(rawClient(client), migrationBundle, MIGRATIONS_TABLE)
    expect(await journalCount(client)).toBe(migrationBundle.length)
    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'host_state'")
    expect(tables.rows).toHaveLength(1)
  })

  it('continues a database that drizzle migrated part of the way', async () => {
    const handle = await libsql(':memory:').open()
    await migrateFromBundle(handle.db, migrationBundle.slice(0, 10))
    const inner = (handle.db as unknown as { $client: Client }).$client

    await migrateInBatch(rawClient(inner), migrationBundle, MIGRATIONS_TABLE)

    expect(await journalCount(inner)).toBe(migrationBundle.length)
    await handle.close()
  })

  it('applies nothing when one statement fails', async () => {
    client = createClient({ url: ':memory:' })
    const broken = [...migrationBundle.slice(0, 3), { ...migrationBundle[3], sql: ['CREATE TABLE broken ('] }]

    await expect(migrateInBatch(rawClient(client), broken, MIGRATIONS_TABLE)).rejects.toThrow()

    expect(await journalCount(client)).toBe(0)
  })
})
