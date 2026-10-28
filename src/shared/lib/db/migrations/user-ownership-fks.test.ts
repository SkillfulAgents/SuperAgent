import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { migrateFromBundle } from '../open-database'
import type { AppDatabase } from '../drivers/types'
import { migrationBundle } from './bundle'

// 0061 rebuilds connected_accounts, remote_mcp_servers and agent_acl with the
// FK to `user` that schema.ts always declared (SUP-220), and scopes the
// provider connection id's uniqueness to its provider (SUP-222).

let handle: TestDatabase | undefined
afterEach(async () => { await handle?.close() })

const fksMigration = migrationBundle.findIndex(m => m.sql.some(s => s.includes('__saved_proxy_rule_versions')))

/** Every table hanging off the two rebuilt parents: dropping a parent cascades into these. */
const CHILD_TABLES = ['agent_connected_accounts', 'api_scope_policies', 'agent_remote_mcps', 'mcp_tool_policies', 'proxy_rules', 'proxy_rule_versions']

async function seedUser(db: AppDatabase, id: string) {
  await db.run(sql`INSERT INTO user (id, name, email) VALUES (${id}, ${id}, ${`${id}@example.com`})`)
}

async function seedRule(db: AppDatabase, ruleId: string, target: { accountId: string } | { mcpId: string }) {
  const [kind, accountId, mcpId] = 'accountId' in target ? ['api', target.accountId, null] : ['mcp', null, target.mcpId]
  await db.run(sql`INSERT INTO proxy_rules (id, kind, account_id, mcp_id, created_by, current_version_id, created_at, updated_at)
    VALUES (${ruleId}, ${kind}, ${accountId}, ${mcpId}, 'user', ${`${ruleId}-v1`}, 1, 1)`)
  await db.run(sql`INSERT INTO proxy_rule_versions (id, rule_id, version, name, effect, description, restatement, patterns, code, tests, warnings, created_at)
    VALUES (${`${ruleId}-v1`}, ${ruleId}, 1, 'Rule', 'block', '', '', '[]', '', '[]', '[]', 1)`)
}

/** An account owned by `owner`, with a row in each of its child tables; the rows' ids derive from `id`. */
async function seedAccount(db: AppDatabase, id: string, owner: string | null, provider = 'composio', connectionId = `conn-${id}`) {
  await db.run(sql`INSERT INTO connected_accounts (id, provider_connection_id, provider_name, toolkit_slug, display_name, user_id, created_at, updated_at)
    VALUES (${id}, ${connectionId}, ${provider}, 'gmail', 'Gmail', ${owner}, 1, 1)`)
  await db.run(sql`INSERT INTO agent_connected_accounts (id, agent_slug, connected_account_id, created_at) VALUES (${id}, 'agent', ${id}, 1)`)
  await db.run(sql`INSERT INTO api_scope_policies (id, account_id, scope, decision, created_at, updated_at) VALUES (${id}, ${id}, '*', 'allow', 1, 1)`)
  await seedRule(db, `${id}-rule`, { accountId: id })
}

async function seedMcp(db: AppDatabase, id: string, owner: string | null) {
  await db.run(sql`INSERT INTO remote_mcp_servers (id, name, url, user_id, auth_type, access_token, oauth_client_secret, created_at, updated_at)
    VALUES (${id}, 'MCP', 'https://mcp.example.com', ${owner}, 'oauth', 'token', 'secret', 1, 1)`)
  await db.run(sql`INSERT INTO agent_remote_mcps (id, agent_slug, remote_mcp_id, created_at) VALUES (${id}, 'agent', ${id}, 1)`)
  await db.run(sql`INSERT INTO mcp_tool_policies (id, mcp_id, tool_name, decision, created_at, updated_at) VALUES (${id}, ${id}, '*', 'allow', 1, 1)`)
  await seedRule(db, `${id}-rule`, { mcpId: id })
}

async function ids(db: AppDatabase, table: string, column = 'id'): Promise<string[]> {
  const rows = await db.all<{ id: string }>(sql`SELECT ${sql.identifier(column)} AS id FROM ${sql.identifier(table)} ORDER BY 1`)
  return rows.map(row => row.id)
}

async function owners(db: AppDatabase, table: string): Promise<Record<string, string | null>> {
  const rows = await db.all<{ id: string; user_id: string | null }>(sql`SELECT id, user_id FROM ${sql.identifier(table)}`)
  return Object.fromEntries(rows.map(row => [row.id, row.user_id]))
}

async function children(db: AppDatabase): Promise<Record<string, string[]>> {
  return Object.fromEntries(await Promise.all(CHILD_TABLES.map(async table => [table, await ids(db, table)])))
}

/** What seedAccount / seedMcp put in each child table for these parents. */
function childrenOf(accounts: string[], mcps: string[]): Record<string, string[]> {
  const rules = [...accounts, ...mcps].map(id => `${id}-rule`).sort()
  return {
    agent_connected_accounts: accounts,
    api_scope_policies: accounts,
    agent_remote_mcps: mcps,
    mcp_tool_policies: mcps,
    proxy_rules: rules,
    proxy_rule_versions: rules.map(id => `${id}-v1`),
  }
}

/** The SQLite error behind drizzle's "Failed to run the query" wrapper. */
async function sqliteError(work: Promise<unknown>): Promise<string> {
  const error = await work.then(() => undefined, (rejection: unknown) => rejection)
  expect(error).toBeInstanceOf(Error)
  return String((error as Error).cause ?? error)
}

async function onDelete(db: AppDatabase, table: string): Promise<string | undefined> {
  const fks = await db.all<{ table: string; from: string; on_delete: string }>(sql`SELECT * FROM pragma_foreign_key_list(${table})`)
  return fks.find(fk => fk.table === 'user' && fk.from === 'user_id')?.on_delete
}

describe('0061 user ownership FKs', () => {
  it('keeps every live, local and unowned row with its children, and drops what a deleted user left', async () => {
    expect(fksMigration).toBeGreaterThan(0)
    handle = await createTestDatabase({ migrations: migrationBundle.slice(0, fksMigration) })
    const db = handle.db
    await seedUser(db, 'ada')
    for (const [suffix, owner] of [['ada', 'ada'], ['local', 'local'], ['none', null], ['gone', 'gone']] as const) {
      await seedAccount(db, `acct-${suffix}`, owner)
      await seedMcp(db, `mcp-${suffix}`, owner)
    }
    await db.run(sql`INSERT INTO agent_acl (id, user_id, agent_slug, role, created_at) VALUES ('acl-ada', 'ada', 'agent', 'owner', 1), ('acl-gone', 'gone', 'agent', 'owner', 1)`)
    await db.run(sql`INSERT INTO user_settings (user_id, settings, updated_at) VALUES ('ada', '{}', 1), ('local', '{}', 1), ('gone', '{}', 1)`)

    await migrateFromBundle(db)

    expect(await owners(db, 'connected_accounts')).toEqual({ 'acct-ada': 'ada', 'acct-local': null, 'acct-none': null })
    expect(await owners(db, 'remote_mcp_servers')).toEqual({ 'mcp-ada': 'ada', 'mcp-local': null, 'mcp-none': null })
    expect(await children(db)).toEqual(childrenOf(['acct-ada', 'acct-local', 'acct-none'], ['mcp-ada', 'mcp-local', 'mcp-none']))
    expect(await ids(db, 'agent_acl')).toEqual(['acl-ada'])
    expect(await ids(db, 'user_settings', 'user_id')).toEqual(['ada', 'local'])
    expect(await db.all(sql`SELECT name FROM sqlite_master WHERE instr(name, '__saved_') = 1 OR instr(name, '__new_') = 1`)).toEqual([])
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([])

    // The rebuilt tables cascade now: deleting ada takes her rows and their children, nobody else's.
    await db.run(sql`DELETE FROM user WHERE id = 'ada'`)
    expect(await ids(db, 'connected_accounts')).toEqual(['acct-local', 'acct-none'])
    expect(await ids(db, 'remote_mcp_servers')).toEqual(['mcp-local', 'mcp-none'])
    expect(await ids(db, 'agent_acl')).toEqual([])
    expect(await children(db)).toEqual(childrenOf(['acct-local', 'acct-none'], ['mcp-local', 'mcp-none']))
  })

  it('declares the cascade on a fresh database and refuses an owner with no user row', async () => {
    handle = await createTestDatabase()
    const db = handle.db
    for (const table of ['connected_accounts', 'remote_mcp_servers', 'agent_acl']) expect(await onDelete(db, table)).toBe('CASCADE')
    expect(await sqliteError(seedAccount(db, 'acct', 'nobody'))).toMatch(/FOREIGN KEY constraint failed/)
    expect(await sqliteError(seedMcp(db, 'mcp', 'local'))).toMatch(/FOREIGN KEY constraint failed/)
  })
})

describe('0061 provider-scoped connection ids', () => {
  it('lets two providers hand out the same connection id, but not one provider twice', async () => {
    handle = await createTestDatabase()
    const db = handle.db
    await seedAccount(db, 'composio-a', null, 'composio', 'shared')
    await seedAccount(db, 'nango-a', null, 'nango', 'shared')
    expect(await ids(db, 'connected_accounts')).toEqual(['composio-a', 'nango-a'])
    expect(await sqliteError(seedAccount(db, 'composio-b', null, 'composio', 'shared'))).toMatch(/UNIQUE constraint failed/)
  })
})
