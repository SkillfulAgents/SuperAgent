import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { and, eq } from 'drizzle-orm'
import * as schema from '../db/schema'

let testSqlite: InstanceType<typeof Database>
let testDb: ReturnType<typeof drizzle<typeof schema>>

vi.mock('../db', () => ({
  get db() {
    return testDb
  },
}))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))

import { changeMemberRole, countMembersWithMinRole, removeMember } from './agent-members-service'

const { agentAcl, user } = schema
const AGENT = 'shared-agent'

function seed(members: Array<{ id: string; role: 'owner' | 'user' | 'viewer' }>) {
  const now = new Date()
  for (const member of members) {
    testDb.insert(user).values({ id: member.id, name: member.id, email: `${member.id}@example.test` }).run()
    testDb.insert(agentAcl).values({ id: `acl-${member.id}`, userId: member.id, agentSlug: AGENT, role: member.role, createdAt: now }).run()
  }
}

function roleOf(userId: string) {
  return testDb.select({ role: agentAcl.role }).from(agentAcl)
    .where(and(eq(agentAcl.userId, userId), eq(agentAcl.agentSlug, AGENT))).get()?.role ?? null
}

function owners() {
  return testDb.select({ id: agentAcl.userId }).from(agentAcl)
    .where(and(eq(agentAcl.agentSlug, AGENT), eq(agentAcl.role, 'owner'))).all().map((row) => row.id).sort()
}

beforeEach(() => {
  testSqlite = new Database(':memory:')
  testSqlite.pragma('foreign_keys = ON')
  testDb = drizzle(testSqlite, { schema })
  migrate(testDb, { migrationsFolder: 'src/shared/lib/db/migrations' })
})

afterEach(() => {
  testSqlite.close()
})

describe('countMembersWithMinRole', () => {
  it('counts members at or above the role, and only on this agent', async () => {
    seed([{ id: 'ann', role: 'owner' }, { id: 'bob', role: 'user' }, { id: 'vic', role: 'viewer' }])
    testDb.insert(agentAcl).values({ id: 'acl-elsewhere', userId: 'bob', agentSlug: 'other-agent', role: 'owner', createdAt: new Date() }).run()
    expect(await countMembersWithMinRole(AGENT, 'user')).toBe(2)
    expect(await countMembersWithMinRole(AGENT, 'owner')).toBe(1)
  })
})

describe('removeMember', () => {
  it('removes a non-owner', async () => {
    seed([{ id: 'ann', role: 'owner' }, { id: 'bob', role: 'user' }])
    expect(await removeMember(AGENT, 'bob')).toBe('done')
    expect(roleOf('bob')).toBeNull()
  })

  it('refuses the last owner', async () => {
    seed([{ id: 'ann', role: 'owner' }, { id: 'bob', role: 'user' }])
    expect(await removeMember(AGENT, 'ann')).toBe('last-owner')
    expect(owners()).toEqual(['ann'])
  })

  it('removes an owner while another remains', async () => {
    seed([{ id: 'ann', role: 'owner' }, { id: 'bob', role: 'owner' }])
    expect(await removeMember(AGENT, 'ann')).toBe('done')
    expect(owners()).toEqual(['bob'])
  })

  it('reports a user who is not a member', async () => {
    seed([{ id: 'ann', role: 'owner' }])
    expect(await removeMember(AGENT, 'nobody')).toBe('not-a-member')
  })

  it('two concurrent revokes of the two owners leave exactly one owner', async () => {
    // Each delete carries its own owner-count guard, so the second one runs
    // against the first one's result instead of a count both read earlier.
    seed([{ id: 'ann', role: 'owner' }, { id: 'bob', role: 'owner' }])

    const outcomes = await Promise.all([removeMember(AGENT, 'ann'), removeMember(AGENT, 'bob')])

    expect(outcomes.sort()).toEqual(['done', 'last-owner'])
    expect(owners()).toHaveLength(1)
  })
})

describe('changeMemberRole', () => {
  it('changes a non-owner role without touching the owner count', async () => {
    // The common case: the role <> 'owner' half of the guard passes on its
    // own, so a sole owner is no obstacle.
    seed([{ id: 'ann', role: 'owner' }, { id: 'bob', role: 'user' }])
    expect(await changeMemberRole(AGENT, 'bob', 'viewer')).toBe('done')
    expect(roleOf('bob')).toBe('viewer')
    expect(owners()).toEqual(['ann'])
  })

  it('demotes an owner while another remains', async () => {
    seed([{ id: 'ann', role: 'owner' }, { id: 'bob', role: 'owner' }])
    expect(await changeMemberRole(AGENT, 'ann', 'viewer')).toBe('done')
    expect(roleOf('ann')).toBe('viewer')
  })

  it('refuses to demote the last owner', async () => {
    seed([{ id: 'ann', role: 'owner' }, { id: 'bob', role: 'user' }])
    expect(await changeMemberRole(AGENT, 'ann', 'user')).toBe('last-owner')
    expect(roleOf('ann')).toBe('owner')
  })

  it('promotes without an owner-count check, and owner to owner is a no-op that succeeds', async () => {
    seed([{ id: 'ann', role: 'owner' }, { id: 'bob', role: 'viewer' }])
    expect(await changeMemberRole(AGENT, 'bob', 'owner')).toBe('done')
    expect(await changeMemberRole(AGENT, 'ann', 'owner')).toBe('done')
    expect(owners()).toEqual(['ann', 'bob'])
  })

  it('reports a user who is not a member', async () => {
    seed([{ id: 'ann', role: 'owner' }])
    expect(await changeMemberRole(AGENT, 'nobody', 'user')).toBe('not-a-member')
  })

  it('two concurrent demotions of the two owners leave exactly one owner', async () => {
    seed([{ id: 'ann', role: 'owner' }, { id: 'bob', role: 'owner' }])

    const outcomes = await Promise.all([
      changeMemberRole(AGENT, 'ann', 'user'),
      changeMemberRole(AGENT, 'bob', 'user'),
    ])

    expect(outcomes.sort()).toEqual(['done', 'last-owner'])
    expect(owners()).toHaveLength(1)
  })
})
