import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

// ---------------------------------------------------------------------------
// SUP-222 — provider connection IDs must be unique *per provider*.
//
// 0021 renamed composio_connection_id -> provider_connection_id but left the
// original single-column UNIQUE index in place, so two different providers
// returning the same opaque connection ID collide on a global unique constraint
// (surfacing a misleading "already connected" 409). Migration 0023 drops the
// single-column index and recreates it as (provider_name, provider_connection_id).
//
// This test applies the full migration chain and asserts both halves of the
// fix: cross-provider duplicates are allowed, same-provider duplicates are not.
// ---------------------------------------------------------------------------

const MIGRATIONS = path.join(process.cwd(), 'src/shared/lib/db/migrations')

let sqlite: InstanceType<typeof Database>
const now = Date.now()

function insertAccount(id: string, connId: string, provider: string) {
  sqlite
    .prepare(
      `INSERT INTO connected_accounts (id,provider_connection_id,provider_name,toolkit_slug,display_name,status,created_at,updated_at)
       VALUES (?,?,?,'gmail','Gmail','active',?,?)`
    )
    .run(id, connId, provider, now, now)
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS })
})

afterEach(() => {
  sqlite?.close()
})

describe('SUP-222 provider-scoped connection id uniqueness', () => {
  it('scopes connected account provider connection IDs by provider name', () => {
    // Two providers can legitimately return the SAME opaque connection id.
    insertAccount('a', 'SHARED', 'composio')
    expect(() => insertAccount('b', 'SHARED', 'nango')).not.toThrow()

    expect(
      (sqlite.prepare(`SELECT count(*) c FROM connected_accounts WHERE provider_connection_id='SHARED'`).get() as { c: number }).c
    ).toBe(2)
  })

  it('still rejects a genuine duplicate within the same provider', () => {
    insertAccount('a', 'SHARED', 'composio')
    expect(() => insertAccount('c', 'SHARED', 'composio')).toThrow(/UNIQUE constraint failed/)
  })

  it('exposes the composite unique index and drops the legacy single-column one', () => {
    const indexes = (
      sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='connected_accounts' AND sql IS NOT NULL`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name)

    expect(indexes).toContain('connected_accounts_provider_conn_unique')
    expect(indexes).not.toContain('connected_accounts_composio_connection_id_unique')

    const composite = sqlite
      .prepare(`PRAGMA index_info('connected_accounts_provider_conn_unique')`)
      .all() as Array<{ name: string }>
    expect(composite.map((c) => c.name)).toEqual(['provider_name', 'provider_connection_id'])
  })
})
