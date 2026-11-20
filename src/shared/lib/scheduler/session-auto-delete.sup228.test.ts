import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentConfig, SessionInfo } from '@shared/lib/types/agent'
import { perTestDatabase } from '@shared/lib/db/testing/per-test-database'
import { notifications } from '@shared/lib/db/schema'
import { createNotification, deleteNotificationsBySessionIds } from '@shared/lib/services/notification-service'

// ============================================================================
// SUP-228 — Session auto-delete leaves stale notifications for deleted sessions
//
// cleanupAgent() removed session JSONL files, unsubscribed their live streams and
// (auth mode only) deleted message_author rows, but it never deleted the
// `notifications` rows for the removed session IDs. Notifications are stored in
// BOTH auth and non-auth modes (userId is nullable), so the leak affects both.
// ============================================================================

const database = perTestDatabase()
vi.mock('@shared/lib/db', () => ({ get db() { return database.db } }))

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
  readStoredAgentPreferences: (slug: string) => mockReadAgentPreferences(slug),
}))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => mockGetSettings(),
}))

vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => mockIsAuthMode(),
}))

vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return { containerHost: hostFromManagerMock({ getClient: () => ({ releaseSession: async () => true, deleteSession: async () => true }) }) }
})

vi.mock('@shared/lib/agent-actor/live/live-sessions', async () => ({
  LiveSessions: (await import('@shared/lib/agent-actor/testing/live-sessions-double')).liveSessionsDouble({
    isActive: (_agentSlug, id) => mockIsSessionActive(id),
    unsubscribe: (_agentSlug, id) => mockUnsubscribeFromSession(id),
  }),
}))

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  listSessionIdsWithPendingWakes: () => Promise.resolve(new Set<string>()),
}))

// Import after mocks are set up.
import { sessionAutoDeleteMonitor } from './session-auto-delete-monitor'
import { registerTasks } from '@shared/lib/background-work/testing/register-tasks'

beforeEach(() => registerTasks(sessionAutoDeleteMonitor))

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
  }
}

function makeAgent(slug: string): AgentConfig {
  return {
    slug,
    frontmatter: { name: slug, createdAt: '2026-01-01T00:00:00Z' },
    instructions: '',
  }
}

async function seedNotifications(agentSlug: string, sessionIds: string[]) {
  for (const sessionId of sessionIds) {
    await createNotification({ agentSlug, sessionId, type: 'session_complete', title: 'Done', body: '' })
  }
}

async function notifiedSessions() {
  const rows = await database.db.select({
    agentSlug: notifications.agentSlug, sessionId: notifications.sessionId,
  }).from(notifications)
  return rows.map(row => `${row.agentSlug}/${row.sessionId}`).sort()
}

// ============================================================================
// Tests
// ============================================================================

describe('SUP-228: session auto-delete removes stale notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()

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
    // The run the timer started ends when its agents' ops have answered, as any I/O.
    await vi.waitFor(() => expect(Reflect.get(sessionAutoDeleteMonitor, 'isProcessing')).toBe(false))
  }

  it('deletes notifications for only the actually-deleted session IDs (non-auth mode)', async () => {
    const now = Date.now()
    const s1 = makeSession('s1', new Date(now - 60 * 86_400_000))
    const s2 = makeSession('s2', new Date(now - 60 * 86_400_000))
    const s3 = makeSession('s3', new Date(now - 60 * 86_400_000))
    await seedNotifications('test-agent', ['s1', 's2', 's3'])

    mockListAgents.mockResolvedValue([makeAgent('test-agent')])
    mockListSessions.mockResolvedValue([s1, s2, s3])
    mockReadSessionMetadata.mockResolvedValue({})
    // s3 simulates a filesystem-delete failure: deletedIds excludes it.
    mockDeleteSessionsBatch.mockImplementation(async (_store: unknown, ids: string[]) => ids.filter((id) => id !== 's3'))
    // Cleanup must run unconditionally, NOT gated on auth mode.
    mockIsAuthMode.mockReturnValue(false)

    await startAndTrigger()

    expect(await notifiedSessions()).toEqual(['test-agent/s3'])
  })

  it('does not delete notifications when nothing was actually deleted', async () => {
    const now = Date.now()
    const s1 = makeSession('s1', new Date(now - 60 * 86_400_000))
    await seedNotifications('test-agent', ['s1'])

    mockListAgents.mockResolvedValue([makeAgent('test-agent')])
    mockListSessions.mockResolvedValue([s1])
    mockReadSessionMetadata.mockResolvedValue({})
    // Every filesystem delete failed → deletedIds is empty.
    mockDeleteSessionsBatch.mockResolvedValue([])

    await startAndTrigger()

    expect(await notifiedSessions()).toEqual(['test-agent/s1'])
  })
})

// ============================================================================
// Direct unit coverage for the reusable helper.
// ============================================================================

describe('SUP-228: deleteNotificationsBySessionIds helper', () => {
  it('deletes one agent\'s notification rows by session id', async () => {
    await seedNotifications('agent-1', ['a', 'b', 'c'])
    await seedNotifications('agent-2', ['a'])

    expect(await deleteNotificationsBySessionIds('agent-1', ['a', 'b'])).toBe(2)
    expect(await notifiedSessions()).toEqual(['agent-1/c', 'agent-2/a'])
  })

  it('is a no-op on an empty session id list', async () => {
    await seedNotifications('agent-1', ['a'])
    const deleteRows = vi.spyOn(database.db, 'delete')
    const deleted = await deleteNotificationsBySessionIds('agent-1', [])

    expect(deleted).toBe(0)
    expect(deleteRows).not.toHaveBeenCalled()
    expect(await notifiedSessions()).toEqual(['agent-1/a'])
  })
})
