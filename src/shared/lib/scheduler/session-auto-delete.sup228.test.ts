import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SessionInfo } from '@shared/lib/types/agent'
import type { AgentConfig } from '@shared/lib/types/agent'

// ============================================================================
// SUP-228 — Session auto-delete leaves stale notifications for deleted sessions
//
// cleanupAgent() removed session JSONL files, unsubscribed the persister and
// (auth mode only) deleted message_author rows, but it never deleted the
// `notifications` rows for the removed session IDs. Notifications are stored in
// BOTH auth and non-auth modes (userId is nullable), so the leak affects both.
//
// These tests mirror session-auto-delete-monitor.test.ts's mocking style. The
// real `notification-service` is intentionally NOT mocked so that the monitor
// drives the real `deleteNotificationsBySessionIds()` helper against the mocked
// `db`/`schema`/`drizzle-orm`, letting us assert the exact delete predicate.
// ============================================================================

// Schema table identities. These are read EAGERLY inside the schema vi.mock
// factory, so they must be available before the (hoisted) module imports run —
// hence vi.hoisted, which is lifted above everything.
const tables = vi.hoisted(() => ({
  notifications: { sessionId: 'notifications.session_id' },
  messageAuthor: { sessionId: 'message_author.session_id' },
  agentAcl: { agentSlug: 'agent_acl.agent_slug', userId: 'agent_acl.user_id' },
}))

interface DeleteCall {
  table: unknown
  predicate: unknown
}
const mockDeleteCalls: DeleteCall[] = []

const mockDbDelete = vi.fn((table: unknown) => ({
  where: (predicate: unknown) => {
    mockDeleteCalls.push({ table, predicate })
    return { changes: 0 }
  },
}))

const mockInArray = vi.fn((col: unknown, vals: unknown) => ({ __pred: 'inArray', col, vals }))

const mockListAgents = vi.fn()
const mockListSessions = vi.fn()
const mockReadSessionMetadata = vi.fn()
const mockDeleteSessionsBatch = vi.fn()
const mockReadAgentPreferences = vi.fn()
const mockGetSettings = vi.fn()
const mockIsAuthMode = vi.fn(() => false)
const mockIsSessionActive = vi.fn((_id: string) => false)
const mockUnsubscribeFromSession = vi.fn()

vi.mock('@shared/lib/services/agent-service', () => ({
  listAgents: () => mockListAgents(),
}))

vi.mock('@shared/lib/services/session-service', () => ({
  listSessions: (slug: string) => mockListSessions(slug),
  readSessionMetadata: (slug: string) => mockReadSessionMetadata(slug),
  deleteSessionsBatch: (slug: string, ids: string[]) => mockDeleteSessionsBatch(slug, ids),
}))

vi.mock('@shared/lib/services/agent-preferences-service', () => ({
  readAgentPreferences: (slug: string) => mockReadAgentPreferences(slug),
}))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => mockGetSettings(),
}))

vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => mockIsAuthMode(),
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    isSessionActive: (id: string) => mockIsSessionActive(id),
    unsubscribeFromSession: (id: string) => mockUnsubscribeFromSession(id),
  },
}))

vi.mock('@shared/lib/db', () => ({
  db: { delete: (table: unknown) => mockDbDelete(table) },
}))

// notification-service imports `notifications` and `agentAcl`; the monitor
// imports `messageAuthor`. Provide stable identities so we can match calls.
vi.mock('@shared/lib/db/schema', () => ({
  notifications: tables.notifications,
  messageAuthor: tables.messageAuthor,
  agentAcl: tables.agentAcl,
}))

// notification-service imports eq/desc/and/lt/inArray/count; the monitor uses
// inArray. Only `inArray` is exercised here — the rest are inert stubs.
vi.mock('drizzle-orm', () => ({
  inArray: (col: unknown, vals: unknown) => mockInArray(col, vals),
  eq: vi.fn((col: unknown, val: unknown) => ({ __pred: 'eq', col, val })),
  and: vi.fn((...a: unknown[]) => ({ __pred: 'and', a })),
  desc: vi.fn(),
  lt: vi.fn(),
  count: vi.fn(),
}))

// NOTE: notification-service is deliberately NOT mocked.

// Import after mocks are set up.
import { sessionAutoDeleteMonitor } from './session-auto-delete-monitor'
import { deleteNotificationsBySessionIds } from '@shared/lib/services/notification-service'

// ============================================================================
// Helpers
// ============================================================================

function makeSession(
  id: string,
  lastActivityAt: Date,
  agentSlug = 'test-agent'
): SessionInfo {
  return {
    id,
    agentSlug,
    name: `Session ${id}`,
    createdAt: new Date('2026-01-01'),
    lastActivityAt,
    messageCount: 5,
  }
}

function makeAgent(slug: string): AgentConfig {
  return {
    slug,
    frontmatter: { name: slug, createdAt: '2026-01-01T00:00:00Z' },
    instructions: '',
  }
}

function notificationDeleteCalls(): DeleteCall[] {
  return mockDeleteCalls.filter((c) => c.table === tables.notifications)
}

// ============================================================================
// Tests
// ============================================================================

describe('SUP-228: session auto-delete removes stale notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockDeleteCalls.length = 0

    mockGetSettings.mockReturnValue({ app: { autoDeleteInactiveDays: 30 } })
    mockListAgents.mockResolvedValue([])
    mockReadAgentPreferences.mockResolvedValue({})
    mockDeleteSessionsBatch.mockImplementation((_slug: string, ids: string[]) =>
      Promise.resolve(ids)
    )
    mockReadSessionMetadata.mockResolvedValue({})
    mockIsSessionActive.mockReturnValue(false)
    mockIsAuthMode.mockReturnValue(false)
  })

  afterEach(async () => {
    sessionAutoDeleteMonitor.stop()
    vi.useRealTimers()
  })

  async function startAndTrigger() {
    await sessionAutoDeleteMonitor.start()
    await vi.advanceTimersByTimeAsync(30_000)
  }

  it('deletes notifications for only the actually-deleted session IDs (non-auth mode)', async () => {
    const now = Date.now()
    const s1 = makeSession('s1', new Date(now - 60 * 86_400_000))
    const s2 = makeSession('s2', new Date(now - 60 * 86_400_000))
    const s3 = makeSession('s3', new Date(now - 60 * 86_400_000))

    mockListAgents.mockResolvedValue([makeAgent('test-agent')])
    mockListSessions.mockResolvedValue([s1, s2, s3])
    mockReadSessionMetadata.mockResolvedValue({})
    // s3 simulates a filesystem-delete failure: deletedIds excludes it.
    mockDeleteSessionsBatch.mockResolvedValue(['s1', 's2'])
    // Cleanup must run unconditionally, NOT gated on auth mode.
    mockIsAuthMode.mockReturnValue(false)

    await startAndTrigger()

    const notifCalls = notificationDeleteCalls()
    expect(notifCalls).toHaveLength(1)
    // The predicate is built over exactly the deletedIds [s1, s2] — not s3,
    // and not the full toDelete list [s1, s2, s3].
    expect(notifCalls[0].predicate).toEqual({
      __pred: 'inArray',
      col: tables.notifications.sessionId,
      vals: ['s1', 's2'],
    })
    expect(mockInArray).toHaveBeenCalledWith(tables.notifications.sessionId, ['s1', 's2'])
  })

  it('does not delete notifications when nothing was actually deleted', async () => {
    const now = Date.now()
    const s1 = makeSession('s1', new Date(now - 60 * 86_400_000))

    mockListAgents.mockResolvedValue([makeAgent('test-agent')])
    mockListSessions.mockResolvedValue([s1])
    mockReadSessionMetadata.mockResolvedValue({})
    // Every filesystem delete failed → deletedIds is empty.
    mockDeleteSessionsBatch.mockResolvedValue([])

    await startAndTrigger()

    expect(notificationDeleteCalls()).toHaveLength(0)
  })
})

// ============================================================================
// Direct unit coverage for the reusable helper.
// ============================================================================

describe('SUP-228: deleteNotificationsBySessionIds helper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeleteCalls.length = 0
  })

  it('deletes notification rows by session id with an inArray predicate', async () => {
    await deleteNotificationsBySessionIds(['a', 'b'])

    const notifCalls = notificationDeleteCalls()
    expect(notifCalls).toHaveLength(1)
    expect(notifCalls[0].predicate).toEqual({
      __pred: 'inArray',
      col: tables.notifications.sessionId,
      vals: ['a', 'b'],
    })
  })

  it('is a no-op on an empty session id list', async () => {
    const deleted = await deleteNotificationsBySessionIds([])

    expect(deleted).toBe(0)
    expect(mockDbDelete).not.toHaveBeenCalled()
  })
})
