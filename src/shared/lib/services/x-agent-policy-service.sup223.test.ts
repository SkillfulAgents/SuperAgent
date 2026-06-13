/**
 * SUP-223 regression tests.
 *
 * x_agent_policies has a UNIQUE(caller, target, operation) index, but SQLite
 * treats NULL target as a distinct value, so the index does NOT dedupe global
 * (target=null) rows. replacePoliciesForCaller() bulk-deletes then reinserts
 * the payload; without dedup, two global entries like (alice, NULL, 'list')
 * with conflicting decisions both persist, and getPolicy/evaluate resolve them
 * non-deterministically via limit(1) with no ORDER BY.
 *
 * These tests mirror the harness in x-agent-policy-service.test.ts (in-memory
 * better-sqlite3 + drizzle migrate).
 */
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
  listPoliciesForCaller,
  replacePoliciesForCaller,
} from './x-agent-policy-service'

describe('x-agent-policy-service (SUP-223: duplicate null-target global policies)', () => {
  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aip-sup223-'))
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
    migrate(testDb, { migrationsFolder })
  })

  afterEach(async () => {
    testSqlite?.close()
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  it('Case 1: dedupes duplicate global list policies (last-write-wins)', () => {
    replacePoliciesForCaller('alice', [
      { operation: 'list', targetSlug: null, decision: 'allow' },
      { operation: 'list', targetSlug: null, decision: 'block' },
    ])

    const globalList = listPoliciesForCaller('alice').filter(
      (r) => r.operation === 'list' && r.targetAgentSlug === null,
    )
    // Before the fix two rows persist (SQLite NULL != NULL in the unique index).
    expect(globalList).toHaveLength(1)
    // Later entry wins.
    expect(globalList[0].decision).toBe('block')
    // evaluate must resolve deterministically to the latest decision.
    expect(evaluate('alice', 'list', null)).toBe('block')
  })

  it('Case 2: dedupes duplicate global read policies (last-write-wins)', () => {
    replacePoliciesForCaller('alice', [
      { operation: 'read', targetSlug: null, decision: 'allow' },
      { operation: 'read', targetSlug: null, decision: 'block' },
    ])

    const globalRead = listPoliciesForCaller('alice').filter(
      (r) => r.operation === 'read' && r.targetAgentSlug === null,
    )
    expect(globalRead).toHaveLength(1)
    expect(globalRead[0].decision).toBe('block')
    // Global read falls back for any target with no specific row.
    expect(evaluate('alice', 'read', 'any-target')).toBe('block')
  })

  it('dedupes duplicate global invoke policies too', () => {
    replacePoliciesForCaller('alice', [
      { operation: 'invoke', targetSlug: null, decision: 'block' },
      { operation: 'invoke', targetSlug: null, decision: 'allow' },
    ])
    const globalInvoke = listPoliciesForCaller('alice').filter(
      (r) => r.operation === 'invoke' && r.targetAgentSlug === null,
    )
    expect(globalInvoke).toHaveLength(1)
    expect(globalInvoke[0].decision).toBe('allow')
    expect(evaluate('alice', 'invoke', 'any-target')).toBe('allow')
  })

  // --- Positive / regression coverage: the dedup must NOT change other behavior ---

  it('keeps a deduped global alongside untouched specific-target rows', () => {
    replacePoliciesForCaller('alice', [
      { operation: 'list', targetSlug: null, decision: 'allow' },
      { operation: 'read', targetSlug: 'bob', decision: 'allow' },
      { operation: 'list', targetSlug: null, decision: 'block' },
    ])

    const rows = listPoliciesForCaller('alice')
    // global list collapses to one row; the specific read:bob row is preserved.
    expect(rows).toHaveLength(2)
    expect(evaluate('alice', 'list', null)).toBe('block')
    expect(evaluate('alice', 'read', 'bob')).toBe('allow')
  })

  it('still rejects duplicate NON-null target rows via the unique index (rolls back)', () => {
    // Non-null duplicates are already enforced by UNIQUE(caller, target, op):
    // the dedup must only cover null-target globals, leaving this behavior intact.
    expect(() =>
      replacePoliciesForCaller('alice', [
        { operation: 'invoke', targetSlug: 'carol', decision: 'allow' },
        { operation: 'invoke', targetSlug: 'carol', decision: 'block' },
      ]),
    ).toThrow()
    // Transaction rolled back — no partial row committed.
    expect(listPoliciesForCaller('alice')).toHaveLength(0)
  })

  it('distinct globals across operations are all kept', () => {
    replacePoliciesForCaller('alice', [
      { operation: 'list', targetSlug: null, decision: 'allow' },
      { operation: 'read', targetSlug: null, decision: 'block' },
      { operation: 'invoke', targetSlug: null, decision: 'allow' },
    ])
    expect(listPoliciesForCaller('alice')).toHaveLength(3)
    expect(evaluate('alice', 'list', null)).toBe('allow')
    expect(evaluate('alice', 'read', 'x')).toBe('block')
    expect(evaluate('alice', 'invoke', 'x')).toBe('allow')
  })
})
