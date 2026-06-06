import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

// ---------------------------------------------------------------------------
// SUP-220 — Auth-mode user deletion must cascade / null the schema-declared
// ownership rows.
//
// schema.ts has always declared FOREIGN KEY(user_id) REFERENCES user(id) on
// connected_accounts / remote_mcp_servers / agent_acl / user_settings
// (onDelete cascade) and notifications (onDelete set null), but the SQL
// migration chain never created those FKs (SQLite cannot add a FK via ALTER).
// With foreign_keys = ON, deleting a Better Auth user therefore orphaned every
// one of these rows. Migration 0022 rebuilds the five tables with the real FKs.
//
// This test builds a fresh migrated DB, seeds a user with a row in every
// ownership table (plus the grandchildren that hang off connected_accounts /
// remote_mcp_servers), deletes the user, and asserts the declared cascade /
// set-null behaviour. It fails before 0022 (all rows remain, notification keeps
// its dangling user_id) and passes once 0022 lands.
// ---------------------------------------------------------------------------

const MIGRATIONS = path.join(process.cwd(), 'src/shared/lib/db/migrations')

let sqlite: InstanceType<typeof Database>

function freshDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(drizzle(db), { migrationsFolder: MIGRATIONS })
  return db
}

const now = Date.now()

function seedUser(db: InstanceType<typeof Database>, id: string) {
  db.prepare(
    `INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,?,?)`
  ).run(id, id, `${id}@example.com`, now, now)
}

function seedOwnership(db: InstanceType<typeof Database>, userId: string) {
  // connected account owned by the user + its two cascade children
  db.prepare(
    `INSERT INTO connected_accounts (id,provider_connection_id,provider_name,toolkit_slug,display_name,status,user_id,created_at,updated_at)
     VALUES ('ca-a','conn-a','composio','gmail','Gmail','active',?,?,?)`
  ).run(userId, now, now)
  db.prepare(
    `INSERT INTO agent_connected_accounts (id,agent_slug,connected_account_id,created_at) VALUES ('aca-a','agent-a','ca-a',?)`
  ).run(now)
  db.prepare(
    `INSERT INTO api_scope_policies (id,account_id,scope,decision,created_at,updated_at) VALUES ('asp-a','ca-a','*','allow',?,?)`
  ).run(now, now)

  // remote mcp owned by the user + its two cascade children
  db.prepare(
    `INSERT INTO remote_mcp_servers (id,name,url,user_id,auth_type,status,created_at,updated_at)
     VALUES ('mcp-a','MCP','https://mcp','${userId}','bearer','active',?,?)`
  ).run(now, now)
  db.prepare(
    `INSERT INTO agent_remote_mcps (id,agent_slug,remote_mcp_id,created_at) VALUES ('arm-a','agent-a','mcp-a',?)`
  ).run(now)
  db.prepare(
    `INSERT INTO mcp_tool_policies (id,mcp_id,tool_name,decision,created_at,updated_at) VALUES ('mtp-a','mcp-a','*','allow',?,?)`
  ).run(now, now)

  // acl, settings, notification
  db.prepare(
    `INSERT INTO agent_acl (id,user_id,agent_slug,role,created_at) VALUES ('acl-a',?,'agent-a','owner',?)`
  ).run(userId, now)
  db.prepare(`INSERT INTO user_settings (user_id,settings,updated_at) VALUES (?,'{}',?)`).run(userId, now)
  db.prepare(
    `INSERT INTO notifications (id,type,session_id,agent_slug,title,body,is_read,user_id,created_at)
     VALUES ('note-a','session_complete','s1','agent-a','t','b',0,?,?)`
  ).run(userId, now)
}

const count = (db: InstanceType<typeof Database>, sql: string) =>
  (db.prepare(sql).get() as { c: number }).c

beforeEach(() => {
  sqlite = freshDb()
})

afterEach(() => {
  sqlite?.close()
})

describe('SUP-220 migrated user-ownership FKs', () => {
  it('declares the user FK on every schema-declared ownership table', () => {
    const fk = (t: string) =>
      (sqlite.prepare(`PRAGMA foreign_key_list(${t})`).all() as Array<{ table: string; from: string; on_delete: string }>)
        .filter((f) => f.table === 'user' && f.from === 'user_id')

    expect(fk('connected_accounts')[0]?.on_delete).toBe('CASCADE')
    expect(fk('remote_mcp_servers')[0]?.on_delete).toBe('CASCADE')
    expect(fk('agent_acl')[0]?.on_delete).toBe('CASCADE')
    expect(fk('user_settings')[0]?.on_delete).toBe('CASCADE')
    expect(fk('notifications')[0]?.on_delete).toBe('SET NULL')
  })

  it('cascades or nulls schema-declared user ownership rows when a user is deleted', () => {
    seedUser(sqlite, 'user-a')
    seedOwnership(sqlite, 'user-a')

    sqlite.prepare(`DELETE FROM user WHERE id = 'user-a'`).run()

    // cascade tables — and the grandchildren hanging off the rebuilt parents
    expect(count(sqlite, `SELECT count(*) c FROM connected_accounts WHERE user_id='user-a'`)).toBe(0)
    expect(count(sqlite, `SELECT count(*) c FROM agent_connected_accounts WHERE id='aca-a'`)).toBe(0)
    expect(count(sqlite, `SELECT count(*) c FROM api_scope_policies WHERE id='asp-a'`)).toBe(0)
    expect(count(sqlite, `SELECT count(*) c FROM remote_mcp_servers WHERE user_id='user-a'`)).toBe(0)
    expect(count(sqlite, `SELECT count(*) c FROM agent_remote_mcps WHERE id='arm-a'`)).toBe(0)
    expect(count(sqlite, `SELECT count(*) c FROM mcp_tool_policies WHERE id='mtp-a'`)).toBe(0)
    expect(count(sqlite, `SELECT count(*) c FROM agent_acl WHERE user_id='user-a'`)).toBe(0)
    expect(count(sqlite, `SELECT count(*) c FROM user_settings WHERE user_id='user-a'`)).toBe(0)

    // notification row survives but its dangling owner is nulled (set null)
    const note = sqlite.prepare(`SELECT user_id FROM notifications WHERE id='note-a'`).get() as
      | { user_id: string | null }
      | undefined
    expect(note).toBeDefined()
    expect(note?.user_id).toBeNull()
  })

  it('preserves unowned (null user_id) connected accounts on unrelated user deletion', () => {
    // non-auth-mode style account: user_id is NULL and must survive a delete
    seedUser(sqlite, 'user-a')
    sqlite
      .prepare(
        `INSERT INTO connected_accounts (id,provider_connection_id,provider_name,toolkit_slug,display_name,status,user_id,created_at,updated_at)
         VALUES ('ca-null','conn-null','composio','slack','Slack','active',NULL,?,?)`
      )
      .run(now, now)

    sqlite.prepare(`DELETE FROM user WHERE id = 'user-a'`).run()

    expect(count(sqlite, `SELECT count(*) c FROM connected_accounts WHERE id='ca-null'`)).toBe(1)
  })
})
