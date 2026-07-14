import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SessionInfo, SessionMetadataMap } from '@shared/lib/types/agent'
import type { AgentConfig } from '@shared/lib/types/agent'

// ============================================================================
// Mocks — must be declared before any import that triggers the module
// ============================================================================

const mockListAgents = vi.fn()
const mockListSessions = vi.fn()
const mockReadSessionMetadata = vi.fn()
const mockDeleteSessionsBatch = vi.fn()
const mockReadAgentPreferences = vi.fn()
const mockGetSettings = vi.fn()
const mockIsAuthMode = vi.fn(() => false)
const mockIsSessionActive = vi.fn((_id: string) => false)
const mockUnsubscribeFromSession = vi.fn()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDbDelete = vi.fn((..._args: any[]) => ({ where: vi.fn(() => ({ changes: 0 })) }))

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

const mockListSessionIdsWithPendingWakes = vi.fn((_slug: string) =>
  Promise.resolve(new Set<string>())
)

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  listSessionIdsWithPendingWakes: (slug: string) =>
    mockListSessionIdsWithPendingWakes(slug),
}))

vi.mock('@shared/lib/db', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: { delete: (...args: any[]) => mockDbDelete(...args) },
}))

vi.mock('@shared/lib/db/schema', () => ({
  messageAuthor: { sessionId: 'message_author_session_id' },
  notifications: { sessionId: 'notifications_session_id' },
  agentAcl: { agentSlug: 'agent_acl_slug', userId: 'agent_acl_user_id' },
}))

vi.mock('drizzle-orm', () => ({
  inArray: vi.fn(),
}))

// Import after mocks are set up
import { sessionAutoDeleteMonitor } from './session-auto-delete-monitor'

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

// ============================================================================
// Tests
// ============================================================================

describe('SessionAutoDeleteMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()

    mockGetSettings.mockReturnValue({ app: {} })
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

  // --------------------------------------------------------------------------
  // Basic lifecycle
  // --------------------------------------------------------------------------

  it('does not run cleanup immediately on start', async () => {
    mockListAgents.mockResolvedValue([makeAgent('agent-1')])
    await sessionAutoDeleteMonitor.start()

    expect(mockListAgents).not.toHaveBeenCalled()
  })

  it('runs cleanup after startup delay', async () => {
    mockListAgents.mockResolvedValue([])
    await startAndTrigger()

    expect(mockListAgents).toHaveBeenCalledOnce()
  })

  // --------------------------------------------------------------------------
  // Setting resolution
  // --------------------------------------------------------------------------

  it('skips agents when global default is undefined and no per-agent override', async () => {
    mockGetSettings.mockReturnValue({ app: {} })
    mockListAgents.mockResolvedValue([makeAgent('agent-1')])
    mockReadAgentPreferences.mockResolvedValue({})

    await startAndTrigger()

    expect(mockListSessions).not.toHaveBeenCalled()
  })

  it('skips agents when global default is 0 (disabled)', async () => {
    mockGetSettings.mockReturnValue({ app: { autoDeleteInactiveDays: 0 } })
    mockListAgents.mockResolvedValue([makeAgent('agent-1')])
    mockReadAgentPreferences.mockResolvedValue({})

    await startAndTrigger()

    expect(mockListSessions).not.toHaveBeenCalled()
  })

  it('uses global default when no per-agent override', async () => {
    const now = Date.now()
    const oldSession = makeSession('old', new Date(now - 31 * 86_400_000))
    const newSession = makeSession('new', new Date(now - 5 * 86_400_000))

    mockGetSettings.mockReturnValue({ app: { autoDeleteInactiveDays: 30 } })
    mockListAgents.mockResolvedValue([makeAgent('test-agent')])
    mockReadAgentPreferences.mockResolvedValue({})
    mockListSessions.mockResolvedValue([oldSession, newSession])
    mockReadSessionMetadata.mockResolvedValue({})

    await startAndTrigger()

    expect(mockDeleteSessionsBatch).toHaveBeenCalledWith('test-agent', ['old'])
  })

  it('uses per-agent override over global default', async () => {
    const now = Date.now()
    const session60dOld = makeSession('s60', new Date(now - 60 * 86_400_000))
    const session100dOld = makeSession('s100', new Date(now - 100 * 86_400_000))

    mockGetSettings.mockReturnValue({ app: { autoDeleteInactiveDays: 30 } })
    mockListAgents.mockResolvedValue([makeAgent('test-agent')])
    mockReadAgentPreferences.mockResolvedValue({ autoDeleteInactiveDays: 90 })
    mockListSessions.mockResolvedValue([session60dOld, session100dOld])
    mockReadSessionMetadata.mockResolvedValue({})

    await startAndTrigger()

    expect(mockDeleteSessionsBatch).toHaveBeenCalledWith('test-agent', ['s100'])
  })

  // --------------------------------------------------------------------------
  // Filtering logic
  // --------------------------------------------------------------------------

  it('preserves starred sessions', async () => {
    const now = Date.now()
    const oldStarred = makeSession('starred', new Date(now - 60 * 86_400_000))
    const oldNormal = makeSession('normal', new Date(now - 60 * 86_400_000))

    mockGetSettings.mockReturnValue({ app: { autoDeleteInactiveDays: 30 } })
    mockListAgents.mockResolvedValue([makeAgent('test-agent')])
    mockReadAgentPreferences.mockResolvedValue({})
    mockListSessions.mockResolvedValue([oldStarred, oldNormal])
    mockReadSessionMetadata.mockResolvedValue({
      starred: { starred: true },
      normal: {},
    })

    await startAndTrigger()

    expect(mockDeleteSessionsBatch).toHaveBeenCalledWith('test-agent', [
      'normal',
    ])
  })

  it('preserves active sessions', async () => {
    const now = Date.now()
    const oldActive = makeSession('active', new Date(now - 60 * 86_400_000))
    const oldInactive = makeSession('inactive', new Date(now - 60 * 86_400_000))

    mockGetSettings.mockReturnValue({ app: { autoDeleteInactiveDays: 30 } })
    mockListAgents.mockResolvedValue([makeAgent('test-agent')])
    mockReadAgentPreferences.mockResolvedValue({})
    mockListSessions.mockResolvedValue([oldActive, oldInactive])
    mockReadSessionMetadata.mockResolvedValue({})
    mockIsSessionActive.mockImplementation(
      (id: string) => id === 'active'
    )

    await startAndTrigger()

    expect(mockDeleteSessionsBatch).toHaveBeenCalledWith('test-agent', [
      'inactive',
    ])
  })

  it('preserves sessions with a pending scheduled wake', async () => {
    const now = Date.now()
    const oldSleeping = makeSession('sleeping', new Date(now - 60 * 86_400_000))
    const oldNormal = makeSession('normal', new Date(now - 60 * 86_400_000))

    mockGetSettings.mockReturnValue({ app: { autoDeleteInactiveDays: 30 } })
    mockListAgents.mockResolvedValue([makeAgent('test-agent')])
    mockReadAgentPreferences.mockResolvedValue({})
    mockListSessions.mockResolvedValue([oldSleeping, oldNormal])
    mockReadSessionMetadata.mockResolvedValue({})
    mockListSessionIdsWithPendingWakes.mockResolvedValue(new Set(['sleeping']))

    await startAndTrigger()

    expect(mockListSessionIdsWithPendingWakes).toHaveBeenCalledWith('test-agent')
    expect(mockDeleteSessionsBatch).toHaveBeenCalledWith('test-agent', ['normal'])
  })

  it('does not delete when no sessions exceed threshold', async () => {
    const now = Date.now()
    const recentSession = makeSession('recent', new Date(now - 5 * 86_400_000))

    mockGetSettings.mockReturnValue({ app: { autoDeleteInactiveDays: 30 } })
    mockListAgents.mockResolvedValue([makeAgent('test-agent')])
    mockReadAgentPreferences.mockResolvedValue({})
    mockListSessions.mockResolvedValue([recentSession])
    mockReadSessionMetadata.mockResolvedValue({})

    await startAndTrigger()

    expect(mockDeleteSessionsBatch).not.toHaveBeenCalled()
  })

  it('skips agents with no sessions', async () => {
    mockGetSettings.mockReturnValue({ app: { autoDeleteInactiveDays: 30 } })
    mockListAgents.mockResolvedValue([makeAgent('empty-agent')])
    mockReadAgentPreferences.mockResolvedValue({})
    mockListSessions.mockResolvedValue([])

    await startAndTrigger()

    expect(mockDeleteSessionsBatch).not.toHaveBeenCalled()
  })

  // --------------------------------------------------------------------------
  // Post-delete cleanup
  // --------------------------------------------------------------------------

  it('calls unsubscribeFromSession for each deleted session', async () => {
    const now = Date.now()
    const old1 = makeSession('old1', new Date(now - 60 * 86_400_000))
    const old2 = makeSession('old2', new Date(now - 60 * 86_400_000))

    mockGetSettings.mockReturnValue({ app: { autoDeleteInactiveDays: 30 } })
    mockListAgents.mockResolvedValue([makeAgent('test-agent')])
    mockReadAgentPreferences.mockResolvedValue({})
    mockListSessions.mockResolvedValue([old1, old2])
    mockReadSessionMetadata.mockResolvedValue({})

    await startAndTrigger()

    expect(mockUnsubscribeFromSession).toHaveBeenCalledWith('old1')
    expect(mockUnsubscribeFromSession).toHaveBeenCalledWith('old2')
  })

  it('only cleans up DB records for actually-deleted sessions', async () => {
    const now = Date.now()
    const old1 = makeSession('ok', new Date(now - 60 * 86_400_000))
    const old2 = makeSession('failed', new Date(now - 60 * 86_400_000))

    mockGetSettings.mockReturnValue({ app: { autoDeleteInactiveDays: 30 } })
    mockListAgents.mockResolvedValue([makeAgent('test-agent')])
    mockReadAgentPreferences.mockResolvedValue({})
    mockListSessions.mockResolvedValue([old1, old2])
    mockReadSessionMetadata.mockResolvedValue({})
    mockIsAuthMode.mockReturnValue(true)
    mockDeleteSessionsBatch.mockResolvedValue(['ok'])

    await startAndTrigger()

    expect(mockDbDelete).toHaveBeenCalled()
    expect(mockUnsubscribeFromSession).toHaveBeenCalledWith('ok')
    expect(mockUnsubscribeFromSession).not.toHaveBeenCalledWith('failed')
  })

  it('cleans notifications but not messageAuthor when not in auth mode', async () => {
    const now = Date.now()
    const old = makeSession('old', new Date(now - 60 * 86_400_000))

    mockGetSettings.mockReturnValue({ app: { autoDeleteInactiveDays: 30 } })
    mockListAgents.mockResolvedValue([makeAgent('test-agent')])
    mockReadAgentPreferences.mockResolvedValue({})
    mockListSessions.mockResolvedValue([old])
    mockReadSessionMetadata.mockResolvedValue({})
    mockIsAuthMode.mockReturnValue(false)

    await startAndTrigger()

    // Notification cleanup is unconditional (notifications exist in both modes);
    // messageAuthor cleanup stays gated on auth mode.
    const deletedTables = mockDbDelete.mock.calls.map((call) => call[0])
    expect(deletedTables).toContainEqual({ sessionId: 'notifications_session_id' })
    expect(deletedTables).not.toContainEqual({ sessionId: 'message_author_session_id' })
  })

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  it('continues to other agents when one fails', async () => {
    const now = Date.now()
    const old = makeSession('old', new Date(now - 60 * 86_400_000))
    old.agentSlug = 'ok-agent'

    mockGetSettings.mockReturnValue({ app: { autoDeleteInactiveDays: 30 } })
    mockListAgents.mockResolvedValue([
      makeAgent('failing-agent'),
      makeAgent('ok-agent'),
    ])
    mockReadAgentPreferences.mockResolvedValue({})
    mockListSessions
      .mockRejectedValueOnce(new Error('disk error'))
      .mockResolvedValueOnce([old])
    mockReadSessionMetadata.mockResolvedValue({})

    await startAndTrigger()

    expect(mockDeleteSessionsBatch).toHaveBeenCalledWith('ok-agent', ['old'])
  })
})
