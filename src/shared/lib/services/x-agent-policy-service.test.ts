import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'

let testDir: string
let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../db', async () => {
  return {
    get db() {
      return testDb
    },
    get sqlite() {
      return testSqlite
    },
  }
})

import {
  evaluate,
  setPolicy,
  getPolicy,
  listPoliciesForCaller,
  deletePoliciesForAgent,
  replacePoliciesForCaller,
  replacePoliciesForCallerInputSchema,
} from './x-agent-policy-service'

describe('x-agent-policy-service', () => {
  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aip-test-'))
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
    migrate(testDb, { migrationsFolder })
  })

  afterEach(async () => {
    testSqlite?.close()
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  describe('evaluate (defaults)', () => {
    it('returns review when no policy exists', () => {
      expect(evaluate('caller', 'list', null)).toBe('review')
      expect(evaluate('caller', 'read', 'target')).toBe('review')
      expect(evaluate('caller', 'invoke', 'target')).toBe('review')
    })
  })

  describe('setPolicy + getPolicy', () => {
    it('inserts a row for list operation (target=null)', async () => {
      await setPolicy('caller', 'list', null, 'allow')
      const row = getPolicy('caller', 'list', null)
      expect(row).not.toBeNull()
      expect(row?.decision).toBe('allow')
      expect(row?.targetAgentSlug).toBeNull()
    })

    it('inserts separate rows for different (target, op) combos', async () => {
      await setPolicy('caller', 'invoke', 'agent-a', 'allow')
      await setPolicy('caller', 'invoke', 'agent-b', 'block')
      await setPolicy('caller', 'read', 'agent-a', 'allow')

      expect(getPolicy('caller', 'invoke', 'agent-a')?.decision).toBe('allow')
      expect(getPolicy('caller', 'invoke', 'agent-b')?.decision).toBe('block')
      expect(getPolicy('caller', 'read', 'agent-a')?.decision).toBe('allow')
      expect(getPolicy('caller', 'read', 'agent-b')).toBeNull()
    })

    it('updates an existing row instead of inserting a duplicate', async () => {
      await setPolicy('caller', 'invoke', 'target', 'review')
      await setPolicy('caller', 'invoke', 'target', 'allow')
      const rows = listPoliciesForCaller('caller')
      const matching = rows.filter(
        (r) => r.operation === 'invoke' && r.targetAgentSlug === 'target',
      )
      expect(matching).toHaveLength(1)
      expect(matching[0].decision).toBe('allow')
    })
  })

  describe('evaluate (with stored policies)', () => {
    it('returns the stored exact-match decision', async () => {
      await setPolicy('caller', 'invoke', 'target', 'allow')
      expect(evaluate('caller', 'invoke', 'target')).toBe('allow')

      await setPolicy('caller', 'invoke', 'blocked', 'block')
      expect(evaluate('caller', 'invoke', 'blocked')).toBe('block')
    })

    it('keeps invoke and read independent — invoke=allow does NOT imply read=allow', async () => {
      // Supports the "trigger but don't browse history" use case.
      await setPolicy('caller', 'invoke', 'target', 'allow')
      expect(evaluate('caller', 'invoke', 'target')).toBe('allow')
      expect(evaluate('caller', 'read', 'target')).toBe('review')
    })

    it('keeps read and invoke independent the other way too — read=allow does not imply invoke=allow', async () => {
      await setPolicy('caller', 'read', 'target', 'allow')
      expect(evaluate('caller', 'read', 'target')).toBe('allow')
      expect(evaluate('caller', 'invoke', 'target')).toBe('review')
    })

    it('list operations are isolated per caller', async () => {
      await setPolicy('caller-a', 'list', null, 'allow')
      expect(evaluate('caller-a', 'list', null)).toBe('allow')
      expect(evaluate('caller-b', 'list', null)).toBe('review')
    })
  })

  describe('deletePoliciesForAgent', () => {
    it('removes all rows where the agent is caller OR target', async () => {
      await setPolicy('alice', 'invoke', 'bob', 'allow')
      await setPolicy('bob', 'invoke', 'alice', 'allow')
      await setPolicy('charlie', 'invoke', 'alice', 'block')
      await setPolicy('alice', 'list', null, 'allow')

      await deletePoliciesForAgent('alice')

      // alice as caller — gone
      expect(getPolicy('alice', 'invoke', 'bob')).toBeNull()
      expect(getPolicy('alice', 'list', null)).toBeNull()
      // alice as target — gone
      expect(getPolicy('bob', 'invoke', 'alice')).toBeNull()
      expect(getPolicy('charlie', 'invoke', 'alice')).toBeNull()
    })

    it('leaves unrelated rows alone', async () => {
      await setPolicy('alice', 'invoke', 'bob', 'allow')
      await setPolicy('charlie', 'invoke', 'dave', 'allow')

      await deletePoliciesForAgent('alice')

      expect(getPolicy('charlie', 'invoke', 'dave')?.decision).toBe('allow')
    })
  })

  describe('listPoliciesForCaller', () => {
    it('returns only rows for the given caller', async () => {
      await setPolicy('alice', 'invoke', 'bob', 'allow')
      await setPolicy('alice', 'read', 'bob', 'review')
      await setPolicy('charlie', 'invoke', 'bob', 'block')

      const aliceRows = listPoliciesForCaller('alice')
      expect(aliceRows).toHaveLength(2)
      expect(aliceRows.map((r) => r.operation).sort()).toEqual(['invoke', 'read'])

      const charlieRows = listPoliciesForCaller('charlie')
      expect(charlieRows).toHaveLength(1)
    })
  })

  describe('replacePoliciesForCaller', () => {
    it('wipes existing rows and inserts the new set atomically', async () => {
      await setPolicy('alice', 'invoke', 'bob', 'allow')
      await setPolicy('alice', 'read', 'bob', 'review')
      await setPolicy('alice', 'list', null, 'allow')

      replacePoliciesForCaller('alice', [
        { operation: 'invoke', targetSlug: 'carol', decision: 'allow' },
        { operation: 'invoke', targetSlug: 'bob', decision: 'block' },
      ])

      const rows = listPoliciesForCaller('alice')
      // Old rows for bob:invoke/bob:read/list are gone; carol:invoke + bob:block are new
      expect(rows).toHaveLength(2)
      const byTarget = Object.fromEntries(
        rows.map((r) => [`${r.operation}:${r.targetAgentSlug}`, r.decision]),
      )
      expect(byTarget['invoke:carol']).toBe('allow')
      expect(byTarget['invoke:bob']).toBe('block')
    })

    it('skips rows with decision=review (treated as default/no-row)', async () => {
      replacePoliciesForCaller('alice', [
        { operation: 'invoke', targetSlug: 'bob', decision: 'allow' },
        { operation: 'read', targetSlug: 'bob', decision: 'review' },
      ])
      const rows = listPoliciesForCaller('alice')
      expect(rows).toHaveLength(1)
      expect(rows[0].operation).toBe('invoke')
    })

    it('does not affect other callers', async () => {
      await setPolicy('charlie', 'invoke', 'bob', 'allow')
      replacePoliciesForCaller('alice', [
        { operation: 'invoke', targetSlug: 'bob', decision: 'block' },
      ])
      expect(getPolicy('charlie', 'invoke', 'bob')?.decision).toBe('allow')
    })

    it('rejects invalid input via Zod schema', () => {
      const result = replacePoliciesForCallerInputSchema.safeParse({
        policies: [{ operation: 'bogus', targetSlug: null, decision: 'allow' }],
      })
      expect(result.success).toBe(false)
    })

    it('accepts an empty list (clears all rows for caller)', async () => {
      await setPolicy('alice', 'invoke', 'bob', 'allow')
      replacePoliciesForCaller('alice', [])
      expect(listPoliciesForCaller('alice')).toHaveLength(0)
    })

    it('rolls back the entire transaction if one insert violates a unique constraint', async () => {
      // Seed a baseline so we can verify it survives unchanged after the failed replace.
      await setPolicy('alice', 'invoke', 'bob', 'allow')
      await setPolicy('alice', 'list', null, 'allow')

      // Two policies with identical (caller='alice', target='carol', op='invoke')
      // — second insert violates the (caller, target, operation) unique index.
      // The transaction wrapper should roll back the delete that runs at the
      // start of replacePoliciesForCaller, leaving the seed rows intact.
      expect(() =>
        replacePoliciesForCaller('alice', [
          { operation: 'invoke', targetSlug: 'carol', decision: 'allow' },
          { operation: 'invoke', targetSlug: 'carol', decision: 'block' },
        ]),
      ).toThrow()

      const rows = listPoliciesForCaller('alice')
      // Both seeded rows must still be present — proves the transaction rolled
      // back the initial DELETE, not just the failing INSERT.
      expect(rows).toHaveLength(2)
      expect(getPolicy('alice', 'invoke', 'bob')?.decision).toBe('allow')
      expect(getPolicy('alice', 'list', null)?.decision).toBe('allow')
      // No partial 'carol' row was committed.
      expect(getPolicy('alice', 'invoke', 'carol')).toBeNull()
    })

    it('handles a large bulk replace (250 rows) without partial visibility', async () => {
      // Drives the transaction with a non-trivial payload to make sure the
      // delete + insert loop scales and stays atomic. Caller observes either
      // all-old or all-new, never a mid-state.
      await setPolicy('alice', 'invoke', 'old-target', 'allow')

      const big = Array.from({ length: 250 }, (_, i) => ({
        operation: 'invoke' as const,
        targetSlug: `bulk-${i}`,
        decision: 'allow' as const,
      }))
      replacePoliciesForCaller('alice', big)

      const rows = listPoliciesForCaller('alice')
      expect(rows).toHaveLength(250)
      // The pre-existing row for old-target must be gone (delete actually ran).
      expect(getPolicy('alice', 'invoke', 'old-target')).toBeNull()
      // Spot-check a few random new rows landed.
      expect(getPolicy('alice', 'invoke', 'bulk-0')?.decision).toBe('allow')
      expect(getPolicy('alice', 'invoke', 'bulk-249')?.decision).toBe('allow')
    })
  })
})
