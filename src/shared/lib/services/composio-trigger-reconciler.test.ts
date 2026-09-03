/**
 * The reconciler must only retry teardowns this host already decided on: an
 * upstream subscription is an orphan when a local cancelled composio row
 * claims it and no active/paused row still subscribes it. Deletes run under
 * the creator member's attribution because the proxy scopes list/delete to
 * the acting member (SUP-765).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'

let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../db', async () => ({
  get db() {
    return testDb
  },
  get sqlite() {
    return testSqlite
  },
}))

vi.mock('../analytics/server-analytics', () => ({
  trackServerEvent: vi.fn(),
}))

const mockIsPlatformComposioActive = vi.fn(() => true)
vi.mock('@shared/lib/composio/client', () => ({
  isPlatformComposioActive: () => mockIsPlatformComposioActive(),
}))

const mockListActiveComposioTriggers = vi.fn<() => Promise<Array<{ id: string }>>>(() =>
  Promise.resolve([]),
)
const mockDeleteComposioTrigger = vi.fn().mockResolvedValue(undefined)
vi.mock('@shared/lib/composio/triggers', () => ({
  listActiveComposioTriggers: () => mockListActiveComposioTriggers(),
  deleteComposioTrigger: (...args: unknown[]) => mockDeleteComposioTrigger(...args),
}))

const mockRequiresActingMember = vi.fn(() => true)
const mockFromMemberId = vi.fn((memberId: string) => ({ key: `attr:${memberId}` }))
const mockRunWithAttribution = vi.fn((_auth: unknown, fn: () => Promise<unknown>) => fn())
vi.mock('@shared/lib/platform-attribution', () => ({
  attribution: {
    requiresActingMember: () => mockRequiresActingMember(),
    fromMemberId: (memberId: string) => mockFromMemberId(memberId),
  },
  runWithAttribution: (auth: unknown, fn: () => Promise<unknown>) =>
    mockRunWithAttribution(auth, fn),
}))

import { reconcileComposioTriggers } from './composio-trigger-reconciler'

function insertUserWithMember(userId: string, memberId: string): void {
  testDb.insert(schema.user).values({
    id: userId,
    name: userId,
    email: `${userId}@test.com`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).run()
  testDb.insert(schema.authAccount).values({
    id: `acc-${userId}`,
    accountId: memberId,
    providerId: 'platform',
    userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).run()
}

function insertTrigger(opts: {
  id: string
  composioTriggerId: string
  status: 'active' | 'paused' | 'cancelled'
  createdByUserId?: string
  kind?: 'composio' | 'custom'
}): void {
  testDb.insert(schema.webhookTriggers).values({
    id: opts.id,
    agentSlug: 'agent-1',
    kind: opts.kind ?? 'composio',
    composioTriggerId: opts.composioTriggerId,
    triggerType: 'GMAIL_NEW_EMAIL',
    prompt: 'Handle it',
    status: opts.status,
    createdByUserId: opts.createdByUserId ?? null,
    createdAt: new Date(),
  }).run()
}

describe('reconcileComposioTriggers (SUP-765)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsPlatformComposioActive.mockReturnValue(true)
    mockRequiresActingMember.mockReturnValue(true)
    mockListActiveComposioTriggers.mockResolvedValue([])
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
  })

  afterEach(() => {
    testSqlite?.close()
  })

  it('deletes an orphan under the creator member attribution', async () => {
    insertUserWithMember('user-creator', 'member-1')
    insertTrigger({
      id: 'wt-1',
      composioTriggerId: 'ti_orphan',
      status: 'cancelled',
      createdByUserId: 'user-creator',
    })
    mockListActiveComposioTriggers.mockResolvedValue([{ id: 'ti_orphan' }])

    const deleted = await reconcileComposioTriggers()

    expect(deleted).toBe(1)
    expect(mockFromMemberId).toHaveBeenCalledWith('member-1')
    expect(mockRunWithAttribution).toHaveBeenCalledWith(
      { key: 'attr:member-1' },
      expect.any(Function),
    )
    expect(mockDeleteComposioTrigger).toHaveBeenCalledWith('ti_orphan')
  })

  it('keeps a subscription that an active sibling still claims', async () => {
    insertUserWithMember('user-creator', 'member-1')
    insertTrigger({
      id: 'wt-cancelled',
      composioTriggerId: 'ti_shared',
      status: 'cancelled',
      createdByUserId: 'user-creator',
    })
    insertTrigger({
      id: 'wt-active',
      composioTriggerId: 'ti_shared',
      status: 'active',
      createdByUserId: 'user-creator',
    })
    mockListActiveComposioTriggers.mockResolvedValue([{ id: 'ti_shared' }])

    const deleted = await reconcileComposioTriggers()

    expect(deleted).toBe(0)
    expect(mockDeleteComposioTrigger).not.toHaveBeenCalled()
  })

  it('skips candidates that upstream no longer reports', async () => {
    insertUserWithMember('user-creator', 'member-1')
    insertTrigger({
      id: 'wt-1',
      composioTriggerId: 'ti_already_gone',
      status: 'cancelled',
      createdByUserId: 'user-creator',
    })
    mockListActiveComposioTriggers.mockResolvedValue([])

    const deleted = await reconcileComposioTriggers()

    expect(deleted).toBe(0)
    expect(mockDeleteComposioTrigger).not.toHaveBeenCalled()
  })

  it('skips unresolvable members in acting-member (org) mode', async () => {
    insertTrigger({
      id: 'wt-1',
      composioTriggerId: 'ti_orphan',
      status: 'cancelled',
      createdByUserId: 'user-gone',
    })

    const deleted = await reconcileComposioTriggers()

    expect(deleted).toBe(0)
    expect(mockListActiveComposioTriggers).not.toHaveBeenCalled()
    expect(mockDeleteComposioTrigger).not.toHaveBeenCalled()
  })

  it('falls back to the local placeholder member in opaque-key mode', async () => {
    mockRequiresActingMember.mockReturnValue(false)
    insertTrigger({
      id: 'wt-1',
      composioTriggerId: 'ti_orphan',
      status: 'cancelled',
    })
    mockListActiveComposioTriggers.mockResolvedValue([{ id: 'ti_orphan' }])

    const deleted = await reconcileComposioTriggers()

    expect(deleted).toBe(1)
    expect(mockFromMemberId).toHaveBeenCalledWith('local')
    expect(mockDeleteComposioTrigger).toHaveBeenCalledWith('ti_orphan')
  })

  it('ignores custom-kind rows (platform endpoints, not Composio subscriptions)', async () => {
    insertUserWithMember('user-creator', 'member-1')
    insertTrigger({
      id: 'wt-custom',
      composioTriggerId: 'whep_endpoint',
      status: 'cancelled',
      createdByUserId: 'user-creator',
      kind: 'custom',
    })
    mockListActiveComposioTriggers.mockResolvedValue([{ id: 'whep_endpoint' }])

    const deleted = await reconcileComposioTriggers()

    expect(deleted).toBe(0)
    expect(mockDeleteComposioTrigger).not.toHaveBeenCalled()
  })

  it('is a no-op when platform Composio is inactive', async () => {
    mockIsPlatformComposioActive.mockReturnValue(false)
    insertUserWithMember('user-creator', 'member-1')
    insertTrigger({
      id: 'wt-1',
      composioTriggerId: 'ti_orphan',
      status: 'cancelled',
      createdByUserId: 'user-creator',
    })

    const deleted = await reconcileComposioTriggers()

    expect(deleted).toBe(0)
    expect(mockListActiveComposioTriggers).not.toHaveBeenCalled()
  })
})
