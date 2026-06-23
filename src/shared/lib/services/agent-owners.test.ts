import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import path from 'node:path'
import * as schema from '../db/schema'

let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../db', () => ({
  get db() { return testDb },
  get sqlite() { return testSqlite },
}))

import { getAgentOwnerIds } from './agent-owners'

describe('getAgentOwnerIds', () => {
  beforeEach(() => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
  })
  afterEach(() => testSqlite.close())

  function addAcl(id: string, userId: string, agentSlug: string, role: string) {
    testSqlite
      .prepare(`INSERT INTO agent_acl (id, user_id, agent_slug, role, created_at) VALUES (?,?,?,?,?)`)
      .run(id, userId, agentSlug, role, Date.now())
  }

  it('returns only the owner-role user ids for the agent', async () => {
    addAcl('a1', 'owner-1', 'agent-x', 'owner')
    addAcl('a2', 'owner-2', 'agent-x', 'owner')
    addAcl('a3', 'editor-1', 'agent-x', 'user')   // non-owner → excluded
    addAcl('a4', 'owner-9', 'agent-y', 'owner')    // other agent → excluded

    const owners = await getAgentOwnerIds('agent-x')
    expect(owners.sort()).toEqual(['owner-1', 'owner-2'])
  })

  it('returns an empty array when the agent has no owner rows', async () => {
    addAcl('a1', 'viewer-1', 'agent-x', 'viewer')
    expect(await getAgentOwnerIds('agent-x')).toEqual([])
  })
})
